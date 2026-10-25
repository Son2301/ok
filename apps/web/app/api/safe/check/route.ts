import { normalizeUrl } from '@/lib/detect';
import { forwardedFor, isSameOrigin, jsonError } from '@/lib/http';
import { type SafeCaller, safeApi } from '@/lib/services';
import { getSession } from '@/lib/session';
import type { CheckKind } from '@/lib/types/safe';

export const dynamic = 'force-dynamic';

const MAX_UPLOAD = 20 * 1024 * 1024;
const TEXT_KINDS: CheckKind[] = ['url', 'text', 'phone', 'bank_account', 'email'];

/**
 * Public scam-check proxy. Signed-in visitors check as their org (history
 * kept, org quota); everyone else is anonymous and the Safe service applies
 * its per-IP free tier to the visitor's forwarded IP.
 */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return jsonError(403, 'forbidden', 'Cross-site request refused');
  const session = await getSession();
  const caller: SafeCaller = session
    ? { orgId: session.org.id, userId: session.user.id }
    : { anonymous: true, forwardedFor: forwardedFor(req.headers) };

  const type = req.headers.get('content-type') ?? '';
  if (type.startsWith('multipart/form-data')) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return jsonError(400, 'bad_request', 'Invalid upload');
    }
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) return jsonError(400, 'bad_request', 'Missing file');
    if (file.size > MAX_UPLOAD) return jsonError(413, 'payload_too_large', 'File too large');
    const kind = file.type.startsWith('video/')
      ? 'video'
      : file.type.startsWith('audio/')
        ? 'audio'
        : 'image';
    const out = new FormData();
    out.set('file', file, file.name || 'upload');
    const res = await safeApi.checkMedia(caller, kind, out);
    return res.ok
      ? Response.json(res.data)
      : Response.json({ error: res.error }, { status: res.error.status || 503 });
  }

  let body: { kind?: string; value?: string; bank?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, 'bad_request', 'Body must be JSON');
  }
  const kind = body.kind as CheckKind;
  const value = typeof body.value === 'string' ? body.value.trim() : '';
  if (!TEXT_KINDS.includes(kind) || !value)
    return jsonError(400, 'bad_request', 'kind and value are required');
  if (value.length > 10_000) return jsonError(413, 'payload_too_large', 'Text too long');

  const payload: Record<string, unknown> =
    kind === 'url'
      ? { url: normalizeUrl(value) ?? value }
      : kind === 'phone'
        ? { phone: value }
        : kind === 'bank_account'
          ? {
              accountNumber: value.replace(/[^\d]/g, '') || value,
              ...(body.bank ? { bankName: String(body.bank).slice(0, 80) } : {}),
            }
          : kind === 'email'
            ? { email: value }
            : { text: value };
  const res = await safeApi.check(caller, kind, payload);
  return res.ok
    ? Response.json(res.data)
    : Response.json({ error: res.error }, { status: res.error.status || 503 });
}
