/**
 * Entry point of the agent runtime container (bundled to `dist/runtime.js`,
 * see `Dockerfile.runtime`). Configuration comes only from the variables the
 * control plane injects, plus image-baked settings for third-party runtimes.
 *
 *   MINH_AGENT_ID, MINH_RUNTIME_TOKEN, MINH_CONTROL_PLANE_URL, MINH_GATEWAY_URL   (injected per agent)
 *   MINH_RUNTIME_MODE=builtin|upstream, MINH_UPSTREAM_URL, MINH_UPSTREAM_API_KEY, MINH_UPSTREAM_MODEL, PORT  (baked into the image)
 */
import { serve } from '@hono/node-server';
import { createRuntimeApp } from './app';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`Missing required environment variable ${name}\n`);
    process.exit(1);
  }
  return v;
}

const mode = process.env.MINH_RUNTIME_MODE === 'upstream' ? 'upstream' : 'builtin';
const app = createRuntimeApp({
  agentId: required('MINH_AGENT_ID'),
  runtimeToken: required('MINH_RUNTIME_TOKEN'),
  controlPlaneUrl: required('MINH_CONTROL_PLANE_URL'),
  gatewayUrl: required('MINH_GATEWAY_URL'),
  mode,
  ...(mode === 'upstream'
    ? {
        upstream: {
          url: required('MINH_UPSTREAM_URL'),
          apiKey: process.env.MINH_UPSTREAM_API_KEY,
          model: process.env.MINH_UPSTREAM_MODEL,
        },
      }
    : {}),
});

const port = Number(process.env.PORT ?? 8080);
const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => {
  process.stdout.write(
    `${JSON.stringify({ t: new Date().toISOString(), msg: 'agent runtime listening', port, mode, agentId: process.env.MINH_AGENT_ID })}\n`,
  );
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
