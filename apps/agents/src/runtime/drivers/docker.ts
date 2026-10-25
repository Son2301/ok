import { AppError } from '@ok/shared';
import type { RuntimeId } from '../../config';
import type { FetchLike } from '../../lib/http';
import { parseSseEvents } from '../../lib/sse';
import { SIGNATURE_HEADER, signRequest, TIMESTAMP_HEADER } from '../signing';
import type { TurnEvent, TurnRequest, TurnResult } from '../types';
import {
  type ContainerCreateSpec,
  type ContainerInspect,
  type DockerApi,
  demuxDockerLogs,
} from './docker-client';
import type { DeploySpec, LogLine, RuntimeDriver, RuntimeStatus, SendOptions, SendTarget } from './types';

export const RUNTIME_PORT = 8080;
export const MANAGED_BY = 'ok-agents';

/** Per-runtime container hardening profile. Third-party runtimes are marked unverified in the README. */
export const RUNTIME_PROFILES: Record<
  RuntimeId,
  { readonlyRootfs: boolean; user?: string; tmpfs: Record<string, string> }
> = {
  // Our own runtime: single JS bundle, runs as an unprivileged user on a read-only rootfs.
  builtin: {
    readonlyRootfs: true,
    user: '10001:10001',
    tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=64m' },
  },
  // OpenClaw/Hermes keep state under their home dir; rootfs stays writable but the container is still unprivileged.
  openclaw: { readonlyRootfs: false, tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=128m' } },
  hermes: { readonlyRootfs: false, tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=128m' } },
};

export interface DockerDriverOptions {
  client: DockerApi;
  images: Record<RuntimeId, string>;
  network: string;
  networkInternal?: boolean;
  /** Allow agent containers to talk to each other on the agents network (default: no). */
  icc?: boolean;
  controlPlaneUrl: string;
  addressMode?: 'ip' | 'name';
  fetch?: FetchLike;
  pullMissingImages?: boolean;
  turnTimeoutMs?: number;
}

export const containerName = (agentId: string) => `ok-agent-${agentId}`;

/**
 * Container spec for an agent. Only these variables enter the container:
 *   OK_AGENT_ID, OK_RUNTIME_TOKEN, OK_CONTROL_PLANE_URL, OK_GATEWAY_URL
 * The gateway URL is the control plane's per-agent LLM proxy (it applies the
 * plan quota/budget and holds the real gateway credentials); the runtime token
 * is its scoped credential. Third-party integration credentials never enter
 * the container — tools execute in the control plane.
 */
export function buildContainerSpec(
  spec: DeploySpec,
  opts: Pick<DockerDriverOptions, 'images' | 'network' | 'controlPlaneUrl'>,
): ContainerCreateSpec {
  const profile = RUNTIME_PROFILES[spec.runtime];
  const base = opts.controlPlaneUrl.replace(/\/+$/, '');
  return {
    Image: opts.images[spec.runtime],
    Env: [
      `OK_AGENT_ID=${spec.agentId}`,
      `OK_RUNTIME_TOKEN=${spec.runtimeToken}`,
      `OK_CONTROL_PLANE_URL=${base}`,
      `OK_GATEWAY_URL=${base}/internal/agents/${spec.agentId}/llm/v1`,
    ],
    Labels: {
      'ok.managed-by': MANAGED_BY,
      'ok.product': 'agents',
      'ok.agent-id': spec.agentId,
      'ok.org-id': spec.orgId,
      'ok.runtime': spec.runtime,
      'ok.plan': spec.plan.id,
    },
    ...(profile.user ? { User: profile.user } : {}),
    ExposedPorts: { [`${RUNTIME_PORT}/tcp`]: {} },
    Healthcheck: {
      Test: [
        'CMD',
        'node',
        '-e',
        `fetch('http://127.0.0.1:${RUNTIME_PORT}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
      ],
      Interval: 30_000_000_000,
      Timeout: 5_000_000_000,
      Retries: 3,
      StartPeriod: 10_000_000_000,
    },
    HostConfig: {
      NanoCpus: Math.round(spec.plan.cpus * 1e9),
      Memory: spec.plan.memoryMb * 1024 * 1024,
      MemorySwap: spec.plan.memoryMb * 1024 * 1024,
      PidsLimit: spec.plan.pidsLimit,
      ReadonlyRootfs: profile.readonlyRootfs,
      Tmpfs: profile.tmpfs,
      Privileged: false,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      NetworkMode: opts.network,
      RestartPolicy: { Name: 'unless-stopped' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
      Init: true,
      ExtraHosts: ['host.docker.internal:host-gateway'],
    },
    NetworkingConfig: { EndpointsConfig: { [opts.network]: {} } },
  };
}

function mapState(info: ContainerInspect | null): RuntimeStatus {
  if (!info) return { state: 'missing' };
  const s = info.State ?? {};
  const base = { containerId: info.Id, image: info.Config?.Image, startedAt: s.StartedAt ?? null };
  if (s.Running) {
    const health = s.Health?.Status;
    return {
      ...base,
      state: health === 'starting' ? 'starting' : 'running',
      ...(health ? { detail: `health=${health}` } : {}),
    };
  }
  switch (s.Status) {
    case 'restarting':
      return { ...base, state: 'starting', detail: 'restarting' };
    case 'dead':
      return { ...base, state: 'error', detail: s.Error || 'container is dead' };
    case 'exited':
      return {
        ...base,
        state: s.ExitCode && s.ExitCode !== 0 ? 'error' : 'stopped',
        detail: s.Error || `exit code ${s.ExitCode ?? 0}`,
      };
    default:
      return { ...base, state: 'stopped', detail: s.Status };
  }
}

/** One hardened container per agent, managed through the Docker Engine API. */
export class DockerDriver implements RuntimeDriver {
  readonly name = 'docker' as const;
  private networkReady = false;
  private readonly fetchFn: FetchLike;

  constructor(private readonly opts: DockerDriverOptions) {
    this.fetchFn = opts.fetch ?? fetch;
  }

  private async ensureNetwork() {
    if (this.networkReady) return;
    if (!(await this.opts.client.inspectNetwork(this.opts.network))) {
      await this.opts.client.createNetwork({
        Name: this.opts.network,
        Driver: 'bridge',
        Internal: Boolean(this.opts.networkInternal),
        CheckDuplicate: true,
        Labels: { 'ok.managed-by': MANAGED_BY },
        Options: { 'com.docker.network.bridge.enable_icc': this.opts.icc ? 'true' : 'false' },
      });
    }
    this.networkReady = true;
  }

  async deploy(spec: DeploySpec): Promise<RuntimeStatus> {
    await this.ensureNetwork();
    const image = this.opts.images[spec.runtime];
    if (this.opts.pullMissingImages !== false && !(await this.opts.client.inspectImage(image)))
      await this.opts.client.pullImage(image);
    const name = containerName(spec.agentId);
    const existing = await this.opts.client.inspectContainer(name);
    if (existing) {
      if (existing.Config?.Labels?.['ok.managed-by'] !== MANAGED_BY)
        throw new AppError('conflict', `Container ${name} exists and is not managed by ok-agents`);
      await this.opts.client.removeContainer(name);
    }
    await this.opts.client.createContainer(name, buildContainerSpec(spec, this.opts));
    await this.opts.client.startContainer(name);
    return this.status(spec.agentId);
  }

  async start(agentId: string): Promise<RuntimeStatus> {
    const name = containerName(agentId);
    if (!(await this.opts.client.inspectContainer(name))) return { state: 'missing' };
    await this.opts.client.startContainer(name);
    return this.status(agentId);
  }

  async stop(agentId: string): Promise<RuntimeStatus> {
    const name = containerName(agentId);
    if (!(await this.opts.client.inspectContainer(name))) return { state: 'missing' };
    await this.opts.client.stopContainer(name, 10);
    return this.status(agentId);
  }

  async remove(agentId: string): Promise<void> {
    await this.opts.client.removeContainer(containerName(agentId));
  }

  async status(agentId: string): Promise<RuntimeStatus> {
    return mapState(await this.opts.client.inspectContainer(containerName(agentId)));
  }

  async logs(agentId: string, opts: { tail?: number } = {}): Promise<LogLine[]> {
    const name = containerName(agentId);
    if (!(await this.opts.client.inspectContainer(name))) return [];
    const buf = await this.opts.client.containerLogs(name, { tail: opts.tail ?? 100 });
    return demuxDockerLogs(buf).map(({ stream, line }) => {
      const m = line.match(/^(\d{4}-\d{2}-\d{2}T\S+)\s(.*)$/);
      return { at: m ? m[1]! : new Date().toISOString(), stream, message: m ? m[2]! : line };
    });
  }

  private async address(agentId: string): Promise<string> {
    const name = containerName(agentId);
    if (this.opts.addressMode === 'name') return `${name}:${RUNTIME_PORT}`;
    const info = await this.opts.client.inspectContainer(name);
    if (!info?.State?.Running) throw new AppError('conflict', 'Agent container is not running');
    const ip = info.NetworkSettings?.Networks?.[this.opts.network]?.IPAddress;
    if (!ip)
      throw new AppError('upstream_error', `Agent container has no address on network ${this.opts.network}`);
    return `${ip}:${RUNTIME_PORT}`;
  }

  async send(target: SendTarget, req: TurnRequest, opts: SendOptions = {}): Promise<TurnResult> {
    if (!target.tokenHash) throw new AppError('conflict', 'Agent has no runtime token; redeploy it');
    const body = JSON.stringify(req);
    const ts = Date.now();
    const timeout = AbortSignal.timeout(this.opts.turnTimeoutMs ?? req.budget.maxMs + 15_000);
    const res = await this.fetchFn(`http://${await this.address(target.agentId)}/turn`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: opts.onEvent ? 'text/event-stream' : 'application/json',
        [TIMESTAMP_HEADER]: String(ts),
        [SIGNATURE_HEADER]: signRequest(target.tokenHash, ts, body),
      },
      body,
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    }).catch((err: Error) => {
      throw new AppError('upstream_error', `Agent runtime unreachable: ${err.message}`);
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AppError('upstream_error', `Agent runtime error ${res.status}: ${text.slice(0, 300)}`);
    }
    if (!opts.onEvent) return (await res.json()) as TurnResult;
    if (!res.body) throw new AppError('upstream_error', 'Agent runtime returned an empty stream');
    for await (const ev of parseSseEvents(res.body)) {
      if (ev.event === 'event') opts.onEvent(JSON.parse(ev.data) as TurnEvent);
      else if (ev.event === 'result') return JSON.parse(ev.data) as TurnResult;
      else if (ev.event === 'error')
        throw new AppError(
          'upstream_error',
          `Agent runtime error: ${(JSON.parse(ev.data) as { message?: string }).message ?? 'unknown'}`,
        );
    }
    throw new AppError('upstream_error', 'Agent runtime stream ended without a result');
  }
}
