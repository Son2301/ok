import { AppError } from '@ok/shared';
import type { Clock } from '../../lib/time';
import { systemClock } from '../../lib/time';
import type { TurnRequest, TurnResult } from '../types';
import type { DeploySpec, LogLine, RuntimeDriver, RuntimeStatus, SendOptions, SendTarget } from './types';

/** Runs a turn in-process (wired by the control plane to the shared agent loop). */
export type InlineExecutor = (target: SendTarget, req: TurnRequest, opts: SendOptions) => Promise<TurnResult>;

interface InlineAgent {
  state: 'running' | 'stopped';
  runtime: string;
  startedAt: Date | null;
  logs: LogLine[];
}

const MAX_LOG_LINES = 500;

/**
 * In-process driver for development, tests and hosts without Docker. Agents
 * share the control-plane process (no isolation): use the docker driver in
 * production. Third-party runtimes (openclaw/hermes) fall back to the builtin loop.
 */
export class InlineDriver implements RuntimeDriver {
  readonly name = 'inline' as const;
  private readonly agents = new Map<string, InlineAgent>();
  private executor: InlineExecutor | null = null;

  constructor(private readonly clock: Clock = systemClock) {}

  setExecutor(fn: InlineExecutor): void {
    this.executor = fn;
  }

  private log(agentId: string, message: string, stream: LogLine['stream'] = 'system') {
    const a = this.agents.get(agentId);
    if (!a) return;
    a.logs.push({ at: this.clock.now().toISOString(), stream, message });
    if (a.logs.length > MAX_LOG_LINES) a.logs.splice(0, a.logs.length - MAX_LOG_LINES);
  }

  private snapshot(agentId: string): RuntimeStatus {
    const a = this.agents.get(agentId);
    if (!a) return { state: 'missing' };
    return { state: a.state, startedAt: a.startedAt?.toISOString() ?? null, detail: `inline (${a.runtime})` };
  }

  async deploy(spec: DeploySpec): Promise<RuntimeStatus> {
    const prev = this.agents.get(spec.agentId);
    this.agents.set(spec.agentId, {
      state: 'running',
      runtime: spec.runtime,
      startedAt: this.clock.now(),
      logs: prev?.logs ?? [],
    });
    this.log(spec.agentId, `deployed (runtime=${spec.runtime}, plan=${spec.plan.id}, driver=inline)`);
    if (spec.runtime !== 'builtin')
      this.log(
        spec.agentId,
        `runtime "${spec.runtime}" is not available inline; using the builtin agent loop`,
      );
    return this.snapshot(spec.agentId);
  }

  async start(agentId: string): Promise<RuntimeStatus> {
    const a = this.agents.get(agentId);
    if (!a) return { state: 'missing' };
    if (a.state !== 'running') {
      a.state = 'running';
      a.startedAt = this.clock.now();
      this.log(agentId, 'started');
    }
    return this.snapshot(agentId);
  }

  async stop(agentId: string): Promise<RuntimeStatus> {
    const a = this.agents.get(agentId);
    if (!a) return { state: 'missing' };
    if (a.state !== 'stopped') {
      a.state = 'stopped';
      a.startedAt = null;
      this.log(agentId, 'stopped');
    }
    return this.snapshot(agentId);
  }

  async remove(agentId: string): Promise<void> {
    this.agents.delete(agentId);
  }

  async status(agentId: string): Promise<RuntimeStatus> {
    return this.snapshot(agentId);
  }

  async logs(agentId: string, opts: { tail?: number } = {}): Promise<LogLine[]> {
    const lines = this.agents.get(agentId)?.logs ?? [];
    return lines.slice(-(opts.tail ?? 100));
  }

  async send(target: SendTarget, req: TurnRequest, opts: SendOptions = {}): Promise<TurnResult> {
    const a = this.agents.get(target.agentId);
    if (a?.state !== 'running') throw new AppError('conflict', 'Agent runtime is not running');
    if (!this.executor) throw new AppError('internal', 'Inline driver has no executor');
    const started = Date.now();
    try {
      const result = await this.executor(target, req, opts);
      this.log(
        target.agentId,
        `turn conversation=${req.conversationId} steps=${result.steps} tools=${result.toolCalls.length} tokens=${result.usage.totalTokens} stop=${result.stopReason} ms=${Date.now() - started}`,
        'stdout',
      );
      return result;
    } catch (err) {
      this.log(
        target.agentId,
        `turn conversation=${req.conversationId} failed: ${(err as Error).message}`,
        'stderr',
      );
      throw err;
    }
  }
}
