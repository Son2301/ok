import { isSameOrigin, jsonError } from '@/lib/http';
import { ServiceError, services } from '@/lib/services';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Test-chat proxy for an agent: forwards the agent's SSE turn stream
 * (`start`, `step`, `delta`, `tool_call`, `tool_result`, `done` | `error`).
 * Each console user gets their own conversation with the agent.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(req)) return jsonError(403, 'forbidden', 'Cross-site request refused');
  const session = await getSession();
  if (!session) return jsonError(401, 'unauthorized', 'Sign in');
  const { id } = await ctx.params;

  let message = '';
  try {
    const body = (await req.json()) as { message?: unknown };
    message = typeof body.message === 'string' ? body.message.trim() : '';
  } catch {
    return jsonError(400, 'bad_request', 'Body must be JSON');
  }
  if (!message || message.length > 8000)
    return jsonError(400, 'bad_request', 'message must be 1–8000 characters');

  try {
    const upstream = await services().raw('agents', `/v1/agents/${encodeURIComponent(id)}/messages/stream`, {
      orgId: session.org.id,
      method: 'POST',
      body: { message, userId: `console:${session.user.id}` },
      timeoutMs: 180_000,
      signal: req.signal,
      headers: { accept: 'text/event-stream' },
    });
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text();
      return new Response(
        text || JSON.stringify({ error: { code: 'upstream_error', message: `HTTP ${upstream.status}` } }),
        {
          status: upstream.status,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    return new Response(upstream.body, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      },
    });
  } catch (err) {
    if (err instanceof ServiceError) return jsonError(503, err.code, err.message);
    if (req.signal.aborted) return new Response(null, { status: 499 });
    throw err;
  }
}
