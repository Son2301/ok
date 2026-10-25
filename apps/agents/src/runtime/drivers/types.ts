import type { Plan, RuntimeId } from '../../config';
import type { TurnEvent, TurnRequest, TurnResult } from '../types';

export type RuntimeState = 'running' | 'stopped' | 'starting' | 'missing' | 'error' | 'unknown';

export interface RuntimeStatus {
  state: RuntimeState;
  detail?: string;
  startedAt?: string | null;
  containerId?: string;
  image?: string;
}

export interface DeploySpec {
  agentId: string;
  orgId: string;
  runtime: RuntimeId;
  plan: Plan;
  /** Plaintext per-agent runtime token (injected into the container; never stored in plaintext). */
  runtimeToken: string;
}

export interface SendTarget {
  agentId: string;
  orgId: string;
  /** sha256 of the container runtime token; key for signing control-plane → runtime requests. */
  tokenHash: string | null;
}

export interface LogLine {
  at: string;
  stream: 'stdout' | 'stderr' | 'system';
  message: string;
}

export interface SendOptions {
  onEvent?: (e: TurnEvent) => void;
  signal?: AbortSignal;
}

/** One interface for every way of running agents (in-process, Docker, …). */
export interface RuntimeDriver {
  readonly name: 'inline' | 'docker';
  deploy(spec: DeploySpec): Promise<RuntimeStatus>;
  start(agentId: string): Promise<RuntimeStatus>;
  stop(agentId: string): Promise<RuntimeStatus>;
  remove(agentId: string): Promise<void>;
  status(agentId: string): Promise<RuntimeStatus>;
  logs(agentId: string, opts?: { tail?: number }): Promise<LogLine[]>;
  send(target: SendTarget, req: TurnRequest, opts?: SendOptions): Promise<TurnResult>;
}
