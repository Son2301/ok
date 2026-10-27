import type { ChatRequest } from '@minh/llm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildPlans } from '../config';
import { createTestPlatform, type TestPlatform } from '../test/helpers';
import { createRuntimeApp } from './app';
import { buildContainerSpec, containerName, DockerDriver } from './drivers/docker';
import type { ContainerCreateSpec, ContainerInspect, DockerApi } from './drivers/docker-client';
import { demuxDockerLogs } from './drivers/docker-client';
import { SIGNATURE_HEADER, signRequest, TIMESTAMP_HEADER, tokenHash, verifyRequest } from './signing';
import type { TurnRequest } from './types';

const plans = buildPlans({
  AGENTS_PLAN_STARTER_PRICE_MICROS: 8_000_000,
  AGENTS_PLAN_STARTER_MONTHLY_TOKENS: 3_000_000,
  AGENTS_PLAN_PRO_PRICE_MICROS: 20_000_000,
  AGENTS_PLAN_PRO_MONTHLY_TOKENS: 10_000_000,
});
const images = {
  builtin: 'ok/agents-runtime:test',
  openclaw: 'ok/agents-runtime-openclaw:test',
  hermes: 'ok/agents-runtime-hermes:test',
};
const IP = '172.18.0.5';

function muxFrame(stream: 1 | 2, text: string) {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/** In-memory Docker Engine double that records every call. */
class FakeDocker implements DockerApi {
  calls: string[] = [];
  networks = new Map<string, Record<string, unknown>>();
  images = new Set<string>();
  containers = new Map<
    string,
    {
      spec: ContainerCreateSpec;
      status: 'created' | 'running' | 'exited';
      exitCode: number;
      labels: Record<string, string>;
    }
  >();
  async ping() {
    return true;
  }
  async inspectNetwork(name: string) {
    this.calls.push(`inspectNetwork ${name}`);
    return this.networks.get(name) ?? null;
  }
  async createNetwork(spec: Record<string, unknown>) {
    this.calls.push(`createNetwork ${spec.Name}`);
    this.networks.set(spec.Name as string, spec);
  }
  async inspectImage(image: string) {
    return this.images.has(image) ? { Id: image } : null;
  }
  async pullImage(image: string) {
    this.calls.push(`pull ${image}`);
    this.images.add(image);
  }
  async createContainer(name: string, spec: ContainerCreateSpec) {
    this.calls.push(`create ${name}`);
    this.containers.set(name, { spec, status: 'created', exitCode: 0, labels: spec.Labels });
    return { Id: `cid-${name}` };
  }
  async startContainer(name: string) {
    this.calls.push(`start ${name}`);
    this.containers.get(name)!.status = 'running';
  }
  async stopContainer(name: string) {
    this.calls.push(`stop ${name}`);
    const c = this.containers.get(name);
    if (c) c.status = 'exited';
  }
  async removeContainer(name: string) {
    this.calls.push(`remove ${name}`);
    this.containers.delete(name);
  }
  async inspectContainer(name: string): Promise<ContainerInspect | null> {
    const c = this.containers.get(name);
    if (!c) return null;
    return {
      Id: `cid-${name}`,
      Config: { Image: c.spec.Image, Labels: c.labels },
      State: {
        Status: c.status,
        Running: c.status === 'running',
        StartedAt: '2026-10-25T03:00:00Z',
        ExitCode: c.exitCode,
      },
      NetworkSettings: { Networks: { 'minh-agents': { IPAddress: IP } } },
    };
  }
  async containerLogs() {
    return Buffer.concat([
      muxFrame(1, '2026-10-25T03:00:01.000000000Z agent runtime listening\n'),
      muxFrame(2, '2026-10-25T03:00:02.000000000Z warn: slow tool\n'),
    ]);
  }
}

describe('container spec', () => {
  const spec = buildContainerSpec(
    {
      agentId: 'agt_abc',
      orgId: 'org_1',
      runtime: 'builtin',
      plan: plans.starter,
      runtimeToken: 'agrt_secret-token',
    },
    { images, network: 'minh-agents', controlPlaneUrl: 'http://control-plane.internal:4100/' },
  );

  it('injects only the agent id, runtime token, control-plane URL and gateway URL', () => {
    expect(spec.Env).toEqual([
      'MINH_AGENT_ID=agt_abc',
      'MINH_RUNTIME_TOKEN=agrt_secret-token',
      'MINH_CONTROL_PLANE_URL=http://control-plane.internal:4100',
      'MINH_GATEWAY_URL=http://control-plane.internal:4100/internal/agents/agt_abc/llm/v1',
    ]);
  });

  it('applies plan limits and hardening', () => {
    expect(spec.Image).toBe('ok/agents-runtime:test');
    expect(spec.User).toBe('10001:10001');
    expect(spec.HostConfig).toMatchObject({
      NanoCpus: 500_000_000,
      Memory: 512 * 1024 * 1024,
      MemorySwap: 512 * 1024 * 1024,
      PidsLimit: 256,
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      NetworkMode: 'minh-agents',
      RestartPolicy: { Name: 'unless-stopped' },
      Init: true,
    });
    expect(spec.HostConfig.Tmpfs?.['/tmp']).toContain('noexec');
    expect(spec.Labels).toEqual({
      'minh.managed-by': 'minh-agents',
      'minh.product': 'agents',
      'minh.agent-id': 'agt_abc',
      'minh.org-id': 'org_1',
      'minh.runtime': 'builtin',
      'minh.plan': 'starter',
    });
    expect(spec).not.toHaveProperty('HostConfig.PortBindings');
    const pro = buildContainerSpec(
      { agentId: 'a', orgId: 'o', runtime: 'openclaw', plan: plans.pro, runtimeToken: 't' },
      { images, network: 'n', controlPlaneUrl: 'http://cp' },
    );
    expect(pro.Image).toBe('ok/agents-runtime-openclaw:test');
    expect(pro.HostConfig).toMatchObject({
      NanoCpus: 1_000_000_000,
      Memory: 1024 * 1024 * 1024,
      ReadonlyRootfs: false,
      Privileged: false,
      CapDrop: ['ALL'],
    });
  });
});

describe('DockerDriver lifecycle (mocked Engine API)', () => {
  it('creates the network, pulls the image, replaces a managed container and starts it', async () => {
    const docker = new FakeDocker();
    const driver = new DockerDriver({
      client: docker,
      images,
      network: 'minh-agents',
      controlPlaneUrl: 'http://cp',
    });
    const status = await driver.deploy({
      agentId: 'agt_1',
      orgId: 'org_1',
      runtime: 'builtin',
      plan: plans.starter,
      runtimeToken: 'agrt_x',
    });
    expect(status).toMatchObject({ state: 'running', image: 'ok/agents-runtime:test' });
    expect(docker.networks.get('minh-agents')).toMatchObject({
      Driver: 'bridge',
      Internal: false,
      Options: { 'com.docker.network.bridge.enable_icc': 'false' },
    });
    expect(docker.calls).toEqual([
      'inspectNetwork minh-agents',
      'createNetwork minh-agents',
      'pull ok/agents-runtime:test',
      'create minh-agent-agt_1',
      'start minh-agent-agt_1',
    ]);

    docker.calls = [];
    await driver.deploy({
      agentId: 'agt_1',
      orgId: 'org_1',
      runtime: 'builtin',
      plan: plans.starter,
      runtimeToken: 'agrt_y',
    });
    expect(docker.calls).toEqual([
      'remove minh-agent-agt_1',
      'create minh-agent-agt_1',
      'start minh-agent-agt_1',
    ]);
    expect(docker.containers.get('minh-agent-agt_1')!.spec.Env).toContain('MINH_RUNTIME_TOKEN=agrt_y');

    expect((await driver.stop('agt_1')).state).toBe('stopped');
    expect((await driver.start('agt_1')).state).toBe('running');
    docker.containers.get('minh-agent-agt_1')!.status = 'exited';
    docker.containers.get('minh-agent-agt_1')!.exitCode = 137;
    expect(await driver.status('agt_1')).toMatchObject({ state: 'error', detail: 'exit code 137' });
    expect(await driver.logs('agt_1')).toEqual([
      { at: '2026-10-25T03:00:01.000000000Z', stream: 'stdout', message: 'agent runtime listening' },
      { at: '2026-10-25T03:00:02.000000000Z', stream: 'stderr', message: 'warn: slow tool' },
    ]);
    await driver.remove('agt_1');
    expect(await driver.status('agt_1')).toEqual({ state: 'missing' });
    expect(await driver.start('agt_1')).toEqual({ state: 'missing' });
  });

  it('refuses to touch containers it does not manage', async () => {
    const docker = new FakeDocker();
    docker.images.add(images.builtin);
    docker.containers.set(containerName('agt_2'), {
      spec: {} as ContainerCreateSpec,
      status: 'running',
      exitCode: 0,
      labels: { 'com.example': 'someone-else' },
    });
    const driver = new DockerDriver({
      client: docker,
      images,
      network: 'minh-agents',
      controlPlaneUrl: 'http://cp',
    });
    await expect(
      driver.deploy({
        agentId: 'agt_2',
        orgId: 'o',
        runtime: 'builtin',
        plan: plans.starter,
        runtimeToken: 't',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('demuxes raw TTY logs too', () => {
    expect(demuxDockerLogs(Buffer.from('line one\nline two\n'))).toEqual([
      { stream: 'stdout', line: 'line one' },
      { stream: 'stdout', line: 'line two' },
    ]);
  });
});

describe('control-plane → runtime request signing', () => {
  it('verifies HMAC signatures keyed by sha256(token) and rejects stale or tampered requests', () => {
    const token = 'agrt_runtime-token';
    const body = '{"hello":"world"}';
    const now = Date.now();
    const sig = signRequest(tokenHash(token), now, body);
    expect(verifyRequest({ token, timestamp: String(now), signature: sig, body, now })).toBe(true);
    expect(verifyRequest({ token, timestamp: String(now), signature: sig, body: `${body} `, now })).toBe(
      false,
    );
    expect(verifyRequest({ token: 'agrt_other', timestamp: String(now), signature: sig, body, now })).toBe(
      false,
    );
    expect(
      verifyRequest({
        token,
        timestamp: String(now - 6 * 60_000),
        signature: signRequest(tokenHash(token), now - 6 * 60_000, body),
        body,
        now,
      }),
    ).toBe(false);
    expect(verifyRequest({ token, timestamp: undefined, signature: sig, body, now })).toBe(false);
  });
});

describe('end to end through the docker driver and the builtin runtime server', () => {
  let t: TestPlatform;
  let docker: FakeDocker;
  let runtimeApp: ReturnType<typeof createRuntimeApp>;
  let agentId: string;
  let runtimeToken: string;

  // Routes "network" traffic: the agent container (by IP) and the control plane (by host).
  const routed = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host === `${IP}:8080`) return runtimeApp.request(url.toString(), init);
    if (url.host === 'control-plane.test') return t.app.request(url.toString(), init);
    throw new Error(`unexpected network call to ${url.host}`);
  };

  beforeAll(async () => {
    docker = new FakeDocker();
    docker.images.add(images.builtin);
    const driver = new DockerDriver({
      client: docker,
      images,
      network: 'minh-agents',
      controlPlaneUrl: 'http://control-plane.test',
      fetch: routed,
    });
    t = await createTestPlatform({
      driver,
      llm: (req: ChatRequest) => {
        const last = req.messages.at(-1)!;
        if (last.role === 'tool') return `Bây giờ là ${JSON.parse(last.content as string).local}`;
        return { tool_calls: [{ id: 'ct1', function: { name: 'get_current_time', arguments: '{}' } }] };
      },
    });
    agentId = (await t.createAgent({ name: 'Containerized' })).id;
    const env = docker.containers.get(containerName(agentId))!.spec.Env;
    const get = (k: string) =>
      env
        .find((e) => e.startsWith(`${k}=`))!
        .split('=')
        .slice(1)
        .join('=');
    runtimeToken = get('MINH_RUNTIME_TOKEN');
    expect(env.join('\n')).not.toMatch(/INTERNAL_TOKEN|internal-token/);
    // The container's own process (simulated): the builtin runtime server with only the injected env.
    runtimeApp = createRuntimeApp({
      agentId: get('MINH_AGENT_ID'),
      runtimeToken,
      controlPlaneUrl: get('MINH_CONTROL_PLANE_URL'),
      gatewayUrl: get('MINH_GATEWAY_URL'),
    });
    vi.stubGlobal('fetch', routed); // the runtime's LLM client and tool proxy calls use global fetch
  });
  afterEach(() => undefined);
  afterAll(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  it('runs the turn in the "container": LLM via the LLM proxy, tools via the tool proxy, results persisted', async () => {
    const res = await t.request('POST', `/v1/agents/${agentId}/messages`, { message: 'Mấy giờ rồi?' });
    expect(res.status).toBe(200);
    expect(res.body.reply).toMatch(/^Bây giờ là Sunday, 2026-10-25 10:00/);
    expect(res.body.toolCalls).toEqual([expect.objectContaining({ name: 'get_current_time', ok: true })]);

    // Tool executed in the control plane through the proxy (trace source = proxy).
    const traces = await t.request('GET', `/v1/agents/${agentId}/tool-calls`);
    expect(traces.body.data[0]).toMatchObject({
      tool: 'get_current_time',
      source: 'proxy',
      conversationId: res.body.conversationId,
    });
    // Both LLM calls went through the broker (usage metered, billed per quota).
    const usage = await t.platform.usage.get(agentId);
    expect(usage?.requests).toBe(2);
    expect(t.llmCalls.every((c) => c.billingOrgId === t.platformOrg.id)).toBe(true);
    // Messages persisted by the control plane.
    const msgs = await t.request(
      'GET',
      `/v1/agents/${agentId}/conversations/${res.body.conversationId}/messages`,
    );
    expect(msgs.body.data.map((m: { role: string }) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
  });

  it('relays streamed events from the container', async () => {
    const res = await t.app.request(`/v1/agents/${agentId}/messages/stream`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Mấy giờ?', userId: 'stream' }),
    });
    const text = await res.text();
    expect(text).toContain('event: tool_call');
    expect(text).toContain('event: tool_result');
    expect(text).toMatch(/event: done\ndata: .*Bây giờ là/);
  });

  it('rejects unsigned turns and foreign tokens at the runtime and the proxies', async () => {
    const turn: TurnRequest = {
      agentId,
      conversationId: 'c',
      model: 'auto',
      messages: [{ role: 'user', content: 'x' }],
      tools: [],
      maxSteps: 1,
      budget: { maxTokens: 100, maxMs: 1000 },
    };
    const unsigned = await runtimeApp.request('/turn', {
      method: 'POST',
      body: JSON.stringify(turn),
      headers: { 'content-type': 'application/json' },
    });
    expect(unsigned.status).toBe(401);
    const body = JSON.stringify({ ...turn, agentId: 'agt_other' });
    const ts = Date.now();
    const wrongAgent = await runtimeApp.request('/turn', {
      method: 'POST',
      body,
      headers: {
        [TIMESTAMP_HEADER]: String(ts),
        [SIGNATURE_HEADER]: signRequest(tokenHash(runtimeToken), ts, body),
      },
    });
    expect(wrongAgent.status).toBe(403);
    const proxy = await t.app.request(
      `http://control-plane.test/internal/agents/${agentId}/llm/v1/chat/completions`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer agrt_forged', 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      },
    );
    expect(proxy.status).toBe(401);
  });

  it('forces the agent model on LLM proxy calls and refuses when the agent is stopped', async () => {
    const call = () =>
      t.app.request(`/internal/agents/${agentId}/llm/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${runtimeToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'very-expensive-model',
          models: ['another'],
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
    const ok = await call();
    expect(ok.status).toBe(200);
    expect(t.llmCalls.at(-1)!.req.model).toBe('auto');
    expect(t.llmCalls.at(-1)!.req.models).toBeUndefined();
    await t.request('POST', `/v1/agents/${agentId}/stop`);
    expect((await call()).status).toBe(409);
    expect(docker.containers.get(containerName(agentId))!.status).toBe('exited');
  });
});

describe('runtime server upstream mode (OpenClaw / Hermes front door)', () => {
  it('forwards the turn to the local OpenAI-compatible endpoint', async () => {
    const upstreamCalls: { url: string; body: unknown; auth: string | null }[] = [];
    const app = createRuntimeApp({
      agentId: 'agt_u',
      runtimeToken: 'agrt_u',
      controlPlaneUrl: 'http://cp',
      gatewayUrl: 'http://cp/internal/agents/agt_u/llm/v1',
      mode: 'upstream',
      upstream: { url: 'http://127.0.0.1:18789/v1', apiKey: 'local-secret', model: 'openclaw' },
      fetch: async (input, init) => {
        upstreamCalls.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
          auth: new Headers(init?.headers).get('authorization'),
        });
        return new Response(
          JSON.stringify({
            id: 'x',
            object: 'chat.completion',
            created: 0,
            model: 'openclaw',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Xin chào từ OpenClaw' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
          }),
          {
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    });
    const turn: TurnRequest = {
      agentId: 'agt_u',
      conversationId: 'cnv_1',
      model: 'auto',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      tools: [],
      maxSteps: 4,
      budget: { maxTokens: 1000, maxMs: 5000 },
    };
    const body = JSON.stringify(turn);
    const ts = Date.now();
    const res = await app.request('/turn', {
      method: 'POST',
      body,
      headers: {
        [TIMESTAMP_HEADER]: String(ts),
        [SIGNATURE_HEADER]: signRequest(tokenHash('agrt_u'), ts, body),
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      reply: 'Xin chào từ OpenClaw',
      stopReason: 'final',
      usage: { totalTokens: 9 },
    });
    expect(upstreamCalls[0]).toMatchObject({
      url: 'http://127.0.0.1:18789/v1/chat/completions',
      auth: 'Bearer local-secret',
      body: { model: 'openclaw', stream: false, messages: turn.messages },
    });
  });
});
