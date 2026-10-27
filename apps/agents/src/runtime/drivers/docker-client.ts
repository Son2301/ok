import http from 'node:http';
import { AppError } from '@minh/shared';

/**
 * The subset of the Docker Engine API the docker driver needs. Implemented
 * over the unix socket by {@link DockerEngineClient}; mocked in tests.
 */
export interface DockerApi {
  ping(): Promise<boolean>;
  inspectNetwork(name: string): Promise<Record<string, unknown> | null>;
  createNetwork(spec: Record<string, unknown>): Promise<void>;
  inspectImage(image: string): Promise<Record<string, unknown> | null>;
  pullImage(image: string): Promise<void>;
  createContainer(name: string, spec: ContainerCreateSpec): Promise<{ Id: string }>;
  startContainer(idOrName: string): Promise<void>;
  stopContainer(idOrName: string, timeoutSec?: number): Promise<void>;
  removeContainer(idOrName: string): Promise<void>;
  inspectContainer(idOrName: string): Promise<ContainerInspect | null>;
  containerLogs(idOrName: string, opts: { tail: number }): Promise<Buffer>;
}

export interface ContainerCreateSpec {
  Image: string;
  Env: string[];
  Labels: Record<string, string>;
  User?: string;
  ExposedPorts?: Record<string, Record<string, never>>;
  Healthcheck?: { Test: string[]; Interval: number; Timeout: number; Retries: number; StartPeriod?: number };
  HostConfig: {
    NanoCpus: number;
    Memory: number;
    MemorySwap: number;
    PidsLimit: number;
    ReadonlyRootfs: boolean;
    Tmpfs?: Record<string, string>;
    Privileged: false;
    CapDrop: string[];
    SecurityOpt: string[];
    NetworkMode: string;
    RestartPolicy: { Name: string; MaximumRetryCount?: number };
    LogConfig: { Type: string; Config: Record<string, string> };
    Init: boolean;
    ExtraHosts?: string[];
  };
  NetworkingConfig?: { EndpointsConfig: Record<string, Record<string, unknown>> };
}

export interface ContainerInspect {
  Id: string;
  Name?: string;
  Config?: { Image?: string; Labels?: Record<string, string> };
  State?: {
    Status?: string;
    Running?: boolean;
    StartedAt?: string;
    Error?: string;
    ExitCode?: number;
    Health?: { Status?: string };
  };
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
}

/** Minimal Docker Engine API client over the unix socket (no dependencies). */
export class DockerEngineClient implements DockerApi {
  constructor(
    private readonly socketPath = '/var/run/docker.sock',
    private readonly timeoutMs = 60_000,
  ) {}

  private request(method: string, path: string, body?: unknown): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: {
            host: 'docker',
            ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new AppError('timeout', `Docker API ${method} ${path} timed out`)));
      req.on('error', (err) =>
        reject(
          err instanceof AppError
            ? err
            : new AppError('upstream_error', `Docker API unavailable: ${err.message}`),
        ),
      );
      if (payload) req.write(payload);
      req.end();
    });
  }

  private async expect(method: string, path: string, ok: number[], body?: unknown) {
    const res = await this.request(method, path, body);
    if (!ok.includes(res.status)) {
      let message = res.body.toString('utf8').slice(0, 500);
      try {
        message = (JSON.parse(message) as { message?: string }).message ?? message;
      } catch {}
      throw new AppError(
        'upstream_error',
        `Docker ${method} ${path.split('?')[0]} failed (${res.status}): ${message}`,
      );
    }
    return res;
  }

  private async getJson<T>(path: string): Promise<T | null> {
    const res = await this.request('GET', path);
    if (res.status === 404) return null;
    if (res.status >= 400) throw new AppError('upstream_error', `Docker GET ${path} failed (${res.status})`);
    return JSON.parse(res.body.toString('utf8')) as T;
  }

  async ping() {
    try {
      const res = await this.request('GET', '/_ping');
      return res.status === 200;
    } catch {
      return false;
    }
  }
  inspectNetwork(name: string) {
    return this.getJson<Record<string, unknown>>(`/networks/${encodeURIComponent(name)}`);
  }
  async createNetwork(spec: Record<string, unknown>) {
    await this.expect('POST', '/networks/create', [201, 409], spec);
  }
  inspectImage(image: string) {
    return this.getJson<Record<string, unknown>>(`/images/${encodeURIComponent(image)}/json`);
  }
  async pullImage(image: string) {
    const lastColon = image.lastIndexOf(':');
    const hasTag = lastColon > image.lastIndexOf('/');
    const from = hasTag ? image.slice(0, lastColon) : image;
    const tag = hasTag ? image.slice(lastColon + 1) : 'latest';
    const res = await this.expect(
      'POST',
      `/images/create?fromImage=${encodeURIComponent(from)}&tag=${encodeURIComponent(tag)}`,
      [200],
    );
    const error = res.body
      .toString('utf8')
      .split('\n')
      .map((l) => {
        try {
          return (JSON.parse(l) as { error?: string }).error;
        } catch {
          return undefined;
        }
      })
      .find(Boolean);
    if (error) throw new AppError('upstream_error', `Docker pull ${image} failed: ${error}`);
  }
  async createContainer(name: string, spec: ContainerCreateSpec) {
    const res = await this.expect('POST', `/containers/create?name=${encodeURIComponent(name)}`, [201], spec);
    return JSON.parse(res.body.toString('utf8')) as { Id: string };
  }
  async startContainer(id: string) {
    await this.expect('POST', `/containers/${encodeURIComponent(id)}/start`, [204, 304]);
  }
  async stopContainer(id: string, timeoutSec = 10) {
    await this.expect('POST', `/containers/${encodeURIComponent(id)}/stop?t=${timeoutSec}`, [204, 304, 404]);
  }
  async removeContainer(id: string) {
    await this.expect('DELETE', `/containers/${encodeURIComponent(id)}?force=true&v=true`, [204, 404]);
  }
  inspectContainer(id: string) {
    return this.getJson<ContainerInspect>(`/containers/${encodeURIComponent(id)}/json`);
  }
  async containerLogs(id: string, opts: { tail: number }) {
    const res = await this.expect(
      'GET',
      `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&timestamps=1&tail=${opts.tail}`,
      [200],
    );
    return res.body;
  }
}

/** Split Docker's multiplexed log stream (8-byte frame headers) into lines. Falls back to raw text for TTY containers. */
export function demuxDockerLogs(buf: Buffer): { stream: 'stdout' | 'stderr'; line: string }[] {
  const out: { stream: 'stdout' | 'stderr'; line: string }[] = [];
  const looksMuxed =
    buf.length >= 8 && (buf[0] === 1 || buf[0] === 2) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!looksMuxed) {
    for (const line of buf.toString('utf8').split('\n')) if (line) out.push({ stream: 'stdout', line });
    return out;
  }
  let off = 0;
  while (off + 8 <= buf.length) {
    const stream = buf[off] === 2 ? 'stderr' : 'stdout';
    const size = buf.readUInt32BE(off + 4);
    const chunk = buf.subarray(off + 8, off + 8 + size).toString('utf8');
    for (const line of chunk.split('\n')) if (line) out.push({ stream, line });
    off += 8 + size;
  }
  return out;
}
