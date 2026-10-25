import { isSameOrigin, jsonError } from '@/lib/http';
import { ServiceError, services } from '@/lib/services';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

interface Body {
  model?: unknown;
  messages?: unknown;
}

const MAX_MESSAGES = 50;
const MAX_CHARS = 100_000;

/**
 * Playground proxy: streams a chat completion from the gateway back to the
 * browser as SSE. The internal token stays on the server; usage is billed to
 * the signed-in org's wallet like any API call.
 */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return jsonError(403, 'forbidden', 'Cross-site request refused');
  const session = await getSession();
  if (!session) return jsonError(401, 'unauthorized', 'Sign in');

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonError(400, 'bad_request', 'Body must be JSON');
  }
  const model = typeof body.model === 'string' && body.model.length <= 200 ? body.model : 'auto';
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > MAX_MESSAGES) {
    return jsonError(400, 'bad_request', 'messages must be a non-empty array');
  }
  const messages: { role: string; content: string }[] = [];
  let chars = 0;
  for (const m of body.messages as { role?: unknown; content?: unknown }[]) {
    if (
      !m ||
      (m.role !== 'system' && m.role !== 'user' && m.role !== 'assistant') ||
      typeof m.content !== 'string'
    ) {
      return jsonError(
        400,
        'bad_request',
        'Each message needs a role (system|user|assistant) and text content',
      );
    }
    chars += m.content.length;
    messages.push({ role: m.role, content: m.content });
  }
  if (chars > MAX_CHARS)
    return jsonError(413, 'payload_too_large', 'Conversation is too long for the playground');

  try {
    const upstream = await services().raw('gateway', '/v1/chat/completions', {
      orgId: session.org.id,
      method: 'POST',
      body: { model, messages, stream: true, stream_options: { include_usage: true } },
      timeoutMs: 300_000,
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
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
        ...(upstream.headers.get('x-generation-id')
          ? { 'x-generation-id': upstream.headers.get('x-generation-id')! }
          : {}),
      },
    });
  } catch (err) {
    if (err instanceof ServiceError) return jsonError(503, err.code, err.message);
    if (req.signal.aborted) return new Response(null, { status: 499 });
    throw err;
  }
}
