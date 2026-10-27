import type { Logger } from '@minh/shared';
import { errorMessage, isTransientError } from './util';

export interface JobContext {
  key: string;
  attempt: number;
}

/** Optional durable mirror of queue state (see Store.saveJob/markJob). Failures are logged, never fatal. */
export interface JobPersistence<T> {
  save(key: string, payload: T, status: 'queued'): Promise<void>;
  mark(
    key: string,
    status: 'running' | 'retrying' | 'done' | 'failed' | 'cancelled',
    patch?: { attempts?: number; lastError?: string | null },
  ): Promise<void>;
}

export interface JobQueueOptions<T> {
  concurrency: number;
  maxAttempts: number;
  /** Delay before retry number `attempt` (1-based attempt that just failed). */
  backoffMs?: (attempt: number) => number;
  isRetryable?: (err: unknown) => boolean;
  /** Combine a queued payload with a newer one for the same key (default: newest wins). */
  merge?: (pending: T, incoming: T) => T;
  persistence?: JobPersistence<T>;
  logger?: Logger;
}

export type EnqueueResult = 'queued' | 'coalesced' | 'deferred';

export const defaultBackoff = (attempt: number) =>
  Math.min(60_000, 2_000 * 2 ** (attempt - 1)) * (0.8 + Math.random() * 0.4);

interface Entry<T> {
  payload: T;
  attempt: number;
}

/**
 * In-process job queue keyed by a coalescing key (one key per pull request):
 *  - at most `concurrency` jobs run at once, and never two for the same key;
 *  - enqueueing a key that is already queued replaces/merges its payload (rapid
 *    pushes collapse into one review of the latest head);
 *  - enqueueing a key that is running schedules exactly one follow-up run;
 *  - transient failures are retried with exponential backoff up to `maxAttempts`.
 */
export class JobQueue<T> {
  private readonly pending = new Map<string, Entry<T>>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly followUps = new Map<string, T>();
  private readonly retrying = new Map<string, Entry<T> & { timer: NodeJS.Timeout }>();
  private idleWaiters: (() => void)[] = [];
  private stopped = false;
  private readonly merge: (a: T, b: T) => T;
  private readonly backoff: (attempt: number) => number;
  private readonly isRetryable: (err: unknown) => boolean;

  constructor(
    private readonly handler: (payload: T, ctx: JobContext) => Promise<void>,
    private readonly opts: JobQueueOptions<T>,
  ) {
    this.merge = opts.merge ?? ((_a, b) => b);
    this.backoff = opts.backoffMs ?? defaultBackoff;
    this.isRetryable = opts.isRetryable ?? isTransientError;
  }

  enqueue(key: string, payload: T): EnqueueResult {
    if (this.stopped) throw new Error('Queue is stopped');
    if (this.running.has(key)) {
      const prev = this.followUps.get(key);
      const next = prev === undefined ? payload : this.merge(prev, payload);
      this.followUps.set(key, next);
      this.persist(() => this.opts.persistence?.save(key, next, 'queued'));
      return 'deferred';
    }
    const retry = this.retrying.get(key);
    if (retry) {
      retry.payload = this.merge(retry.payload, payload);
      return 'coalesced';
    }
    const queued = this.pending.get(key);
    if (queued) {
      queued.payload = this.merge(queued.payload, payload);
      this.persist(() => this.opts.persistence?.save(key, queued.payload, 'queued'));
      return 'coalesced';
    }
    this.pending.set(key, { payload, attempt: 1 });
    this.persist(() => this.opts.persistence?.save(key, payload, 'queued'));
    this.pump();
    return 'queued';
  }

  /** Drop queued/retrying/follow-up work for a key (a running job finishes normally). */
  cancel(key: string): boolean {
    let removed = this.pending.delete(key);
    removed = this.followUps.delete(key) || removed;
    const retry = this.retrying.get(key);
    if (retry) {
      clearTimeout(retry.timer);
      this.retrying.delete(key);
      removed = true;
    }
    if (removed && !this.running.has(key)) this.persist(() => this.opts.persistence?.mark(key, 'cancelled'));
    this.checkIdle();
    return removed;
  }

  get stats() {
    return {
      pending: this.pending.size,
      running: this.running.size,
      retrying: this.retrying.size,
      followUps: this.followUps.size,
    };
  }

  isQueued(key: string): boolean {
    return this.pending.has(key) || this.running.has(key) || this.retrying.has(key);
  }

  /** Resolves once nothing is queued, running or waiting to retry. */
  onIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Stop taking work; waits for running jobs. Persisted unfinished jobs are recovered on the next boot. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const r of this.retrying.values()) clearTimeout(r.timer);
    this.retrying.clear();
    await Promise.allSettled([...this.running.values()]);
  }

  private isIdle() {
    return this.pending.size === 0 && this.running.size === 0 && this.retrying.size === 0;
  }

  private checkIdle() {
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  private pump() {
    while (!this.stopped && this.running.size < this.opts.concurrency) {
      const next = this.pending.entries().next();
      if (next.done) break;
      const [key, entry] = next.value;
      this.pending.delete(key);
      this.start(key, entry);
    }
    this.checkIdle();
  }

  private start(key: string, entry: Entry<T>) {
    const run = (async () => {
      this.persist(() => this.opts.persistence?.mark(key, 'running', { attempts: entry.attempt }));
      try {
        await this.handler(entry.payload, { key, attempt: entry.attempt });
        if (!this.followUps.has(key))
          this.persist(() => this.opts.persistence?.mark(key, 'done', { lastError: null }));
      } catch (err) {
        const msg = errorMessage(err);
        const retry = entry.attempt < this.opts.maxAttempts && this.isRetryable(err);
        if (retry && !this.followUps.has(key) && !this.stopped) {
          const delay = this.backoff(entry.attempt);
          this.opts.logger?.warn('job failed, will retry', {
            key,
            attempt: entry.attempt,
            delayMs: Math.round(delay),
            err: msg,
          });
          const timer = setTimeout(() => {
            const r = this.retrying.get(key);
            if (!r) return;
            this.retrying.delete(key);
            this.pending.set(key, { payload: r.payload, attempt: r.attempt });
            this.pump();
          }, delay);
          timer.unref?.();
          this.retrying.set(key, { payload: entry.payload, attempt: entry.attempt + 1, timer });
          this.persist(() =>
            this.opts.persistence?.mark(key, 'retrying', { attempts: entry.attempt, lastError: msg }),
          );
        } else {
          this.opts.logger?.error('job failed', { key, attempt: entry.attempt, err: msg });
          if (!this.followUps.has(key))
            this.persist(() =>
              this.opts.persistence?.mark(key, 'failed', { attempts: entry.attempt, lastError: msg }),
            );
        }
      } finally {
        this.running.delete(key);
        const follow = this.followUps.get(key);
        if (follow !== undefined) {
          this.followUps.delete(key);
          if (!this.stopped) this.pending.set(key, { payload: follow, attempt: 1 });
        }
        this.pump();
      }
    })();
    this.running.set(key, run);
  }

  private persist(fn: () => Promise<void> | undefined) {
    try {
      fn()?.catch((err) => this.opts.logger?.warn('job persistence failed', { err: errorMessage(err) }));
    } catch (err) {
      this.opts.logger?.warn('job persistence failed', { err: errorMessage(err) });
    }
  }
}
