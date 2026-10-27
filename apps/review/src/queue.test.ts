import { AppError } from '@minh/shared';
import { describe, expect, it } from 'vitest';
import { JobQueue } from './queue';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A handler whose runs can be released manually. */
function controllable<T>() {
  const runs: { payload: T; attempt: number; release: () => void; fail: (e: unknown) => void }[] = [];
  const handler = (payload: T, ctx: { attempt: number }) =>
    new Promise<void>((resolve, reject) => {
      runs.push({ payload, attempt: ctx.attempt, release: resolve, fail: reject });
    });
  return { runs, handler };
}

describe('JobQueue', () => {
  it('respects the concurrency limit', async () => {
    const { runs, handler } = controllable<number>();
    const q = new JobQueue(handler, { concurrency: 2, maxAttempts: 1 });
    q.enqueue('a', 1);
    q.enqueue('b', 2);
    q.enqueue('c', 3);
    await tick();
    expect(runs.map((r) => r.payload)).toEqual([1, 2]);
    expect(q.stats).toMatchObject({ running: 2, pending: 1 });
    runs[0]!.release();
    await tick();
    expect(runs.map((r) => r.payload)).toEqual([1, 2, 3]);
    runs[1]!.release();
    runs[2]!.release();
    await q.onIdle();
  });

  it('coalesces rapid enqueues of a queued key into one run with the merged payload', async () => {
    const { runs, handler } = controllable<{ head: string; full?: boolean }>();
    const q = new JobQueue(handler, {
      concurrency: 1,
      maxAttempts: 1,
      merge: (a, b) => ({ head: b.head, full: a.full || b.full }),
    });
    q.enqueue('blocker', { head: 'x' });
    expect(q.enqueue('pr', { head: 'a', full: true })).toBe('queued');
    expect(q.enqueue('pr', { head: 'b' })).toBe('coalesced');
    expect(q.enqueue('pr', { head: 'c' })).toBe('coalesced');
    await tick();
    runs[0]!.release();
    await tick();
    expect(runs.map((r) => r.payload)).toEqual([{ head: 'x' }, { head: 'c', full: true }]);
    runs[1]!.release();
    await q.onIdle();
  });

  it('never runs the same key twice concurrently; pushes during a run cause exactly one follow-up', async () => {
    const { runs, handler } = controllable<string>();
    const q = new JobQueue(handler, { concurrency: 4, maxAttempts: 1 });
    q.enqueue('pr', 'sha1');
    await tick();
    expect(q.enqueue('pr', 'sha2')).toBe('deferred');
    expect(q.enqueue('pr', 'sha3')).toBe('deferred');
    await tick();
    expect(runs).toHaveLength(1);
    runs[0]!.release();
    await tick();
    expect(runs.map((r) => r.payload)).toEqual(['sha1', 'sha3']);
    runs[1]!.release();
    await q.onIdle();
    expect(runs).toHaveLength(2);
  });

  it('retries transient errors with backoff and gives up on permanent ones', async () => {
    const attempts: number[] = [];
    const delays: number[] = [];
    const q = new JobQueue<string>(
      async (p, ctx) => {
        attempts.push(ctx.attempt);
        if (p === 'flaky' && ctx.attempt < 3) throw new AppError('upstream_error', 'gateway 502');
        if (p === 'fatal') throw new AppError('bad_request', 'nope');
      },
      {
        concurrency: 1,
        maxAttempts: 3,
        backoffMs: (a) => {
          delays.push(a);
          return 1;
        },
      },
    );
    q.enqueue('k1', 'flaky');
    await q.onIdle();
    expect(attempts).toEqual([1, 2, 3]);
    expect(delays).toEqual([1, 2]);

    attempts.length = 0;
    q.enqueue('k2', 'fatal');
    await q.onIdle();
    expect(attempts).toEqual([1]);
  });

  it('stops retrying after maxAttempts', async () => {
    let calls = 0;
    const q = new JobQueue<string>(
      async () => {
        calls++;
        throw Object.assign(new Error('Server Error'), { status: 502 });
      },
      { concurrency: 1, maxAttempts: 2, backoffMs: () => 1 },
    );
    q.enqueue('k', 'x');
    await q.onIdle();
    expect(calls).toBe(2);
  });

  it('cancels queued work and mirrors state to persistence', async () => {
    const events: string[] = [];
    const { runs, handler } = controllable<string>();
    const q = new JobQueue(handler, {
      concurrency: 1,
      maxAttempts: 1,
      persistence: {
        save: async (k, _p, s) => {
          events.push(`${k}:${s}`);
        },
        mark: async (k, s) => {
          events.push(`${k}:${s}`);
        },
      },
    });
    q.enqueue('a', '1');
    q.enqueue('b', '2');
    expect(q.cancel('b')).toBe(true);
    expect(q.cancel('zzz')).toBe(false);
    await tick();
    runs[0]!.release();
    await q.onIdle();
    await tick();
    expect(runs).toHaveLength(1);
    // `a` starts immediately (free slot), `b` waits and is cancelled before it runs.
    expect(events).toEqual(['a:queued', 'a:running', 'b:queued', 'b:cancelled', 'a:done']);
  });
});
