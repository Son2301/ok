import type { FetchLike } from '../verdict/signal';
import { timedFetch } from '../verdict/signal';
import type { MediaKind } from './containers';

/*
 * External AI/deepfake detector adapters. Implemented against each provider's public docs,
 * unit-tested with fixtures, NOT yet exercised against the live services: verified: false.
 * Media is uploaded to the provider only when its key is configured (see README privacy notes).
 * Published false-alarm rates for such detectors range widely (roughly 5–66%), so results are
 * presented as hints and their weight is bounded.
 */

export interface DetectorInput {
  bytes: Uint8Array;
  mime: string;
  filename: string;
  kind: MediaKind;
}

export interface DetectorResult {
  name: string;
  status: 'ok' | 'skipped' | 'error';
  detail?: string;
  /** Probability (0–1) that the media is AI-generated / manipulated. */
  aiProbability?: number;
  verified: false;
}

export interface MediaDetector {
  name: string;
  supports(kind: MediaKind): boolean;
  detect(input: DetectorInput): Promise<DetectorResult>;
}

const err = (name: string, e: unknown): DetectorResult => ({
  name,
  status: 'error',
  detail: (e as Error)?.message ?? String(e),
  verified: false,
});

function formFile(input: DetectorInput): Blob {
  return new Blob([input.bytes as Uint8Array<ArrayBuffer>], { type: input.mime });
}

// ---------------------------------------------------------------- Hive AI

export interface HiveResponse {
  status?: {
    status?: { code?: string; message?: string };
    response?: { output?: { classes?: { class: string; score: number }[] }[] };
  }[];
}

/** https://docs.thehive.ai — sync task API, `Authorization: Token <key>`. verified: false */
export function hiveDetector(apiKey: string, fetchFn: FetchLike): MediaDetector {
  const name = 'hive';
  return {
    name,
    supports: (k) => k === 'image' || k === 'video',
    async detect(input) {
      try {
        const form = new FormData();
        form.append('media', formFile(input), input.filename);
        const res = await timedFetch(
          fetchFn,
          'https://api.thehive.ai/api/v2/task/sync',
          { method: 'POST', headers: { authorization: `Token ${apiKey}` }, body: form },
          30_000,
        );
        if (!res.ok) return err(name, `HTTP ${res.status}`);
        return parseHiveResponse((await res.json()) as HiveResponse);
      } catch (e) {
        return err(name, e);
      }
    },
  };
}

export function parseHiveResponse(body: HiveResponse): DetectorResult {
  const name = 'hive';
  const outputs = body.status?.flatMap((s) => s.response?.output ?? []) ?? [];
  let best: number | undefined;
  for (const o of outputs) {
    for (const c of o.classes ?? []) {
      if (c.class === 'ai_generated' || c.class === 'deepfake') best = Math.max(best ?? 0, c.score);
    }
  }
  if (best === undefined)
    return { name, status: 'error', detail: 'No ai_generated/deepfake class in response', verified: false };
  return { name, status: 'ok', aiProbability: best, verified: false };
}

// ---------------------------------------------------------------- Sightengine

export interface SightengineResponse {
  status?: string;
  error?: { message?: string };
  type?: { ai_generated?: number; deepfake?: number };
  data?: { frames?: { type?: { ai_generated?: number; deepfake?: number } }[] };
}

/** https://sightengine.com/docs — `genai` (+ `deepfake`) models. verified: false */
export function sightengineDetector(apiUser: string, apiSecret: string, fetchFn: FetchLike): MediaDetector {
  const name = 'sightengine';
  return {
    name,
    supports: (k) => k === 'image' || k === 'video',
    async detect(input) {
      try {
        const form = new FormData();
        form.append('media', formFile(input), input.filename);
        form.append('models', input.kind === 'image' ? 'genai,deepfake' : 'genai');
        form.append('api_user', apiUser);
        form.append('api_secret', apiSecret);
        const url =
          input.kind === 'image'
            ? 'https://api.sightengine.com/1.0/check.json'
            : 'https://api.sightengine.com/1.0/video/check-sync.json';
        const res = await timedFetch(fetchFn, url, { method: 'POST', body: form }, 30_000);
        if (!res.ok) return err(name, `HTTP ${res.status}`);
        return parseSightengineResponse((await res.json()) as SightengineResponse);
      } catch (e) {
        return err(name, e);
      }
    },
  };
}

export function parseSightengineResponse(body: SightengineResponse): DetectorResult {
  const name = 'sightengine';
  if (body.status !== 'success')
    return { name, status: 'error', detail: body.error?.message ?? `status ${body.status}`, verified: false };
  const scores = [
    body.type?.ai_generated,
    body.type?.deepfake,
    ...(body.data?.frames ?? []).flatMap((f) => [f.type?.ai_generated, f.type?.deepfake]),
  ].filter((x): x is number => typeof x === 'number');
  if (!scores.length)
    return { name, status: 'error', detail: 'No ai_generated score in response', verified: false };
  return { name, status: 'ok', aiProbability: Math.max(...scores), verified: false };
}

// ---------------------------------------------------------------- Reality Defender

export interface RealityDefenderResult {
  resultsSummary?: { status?: string; metadata?: { finalScore?: number | null } };
  overallStatus?: string;
}

/**
 * https://docs.realitydefender.com — presigned upload, then poll results by requestId.
 * verified: false
 */
export function realityDefenderDetector(
  apiKey: string,
  fetchFn: FetchLike,
  opts: { maxWaitMs: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; baseUrl?: string },
): MediaDetector {
  const name = 'reality_defender';
  const base = opts.baseUrl ?? 'https://api.prd.realitydefender.xyz';
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    name,
    supports: () => true,
    async detect(input) {
      try {
        const pre = await timedFetch(
          fetchFn,
          `${base}/api/files/aws-presigned`,
          {
            method: 'POST',
            headers: { 'X-API-KEY': apiKey, 'content-type': 'application/json' },
            body: JSON.stringify({ fileName: input.filename }),
          },
          15_000,
        );
        if (!pre.ok) return err(name, `presign HTTP ${pre.status}`);
        const p = (await pre.json()) as { response?: { signedUrl?: string }; requestId?: string };
        const signedUrl = p.response?.signedUrl;
        const requestId = p.requestId;
        if (!signedUrl || !requestId) return err(name, 'presign response missing signedUrl/requestId');
        const up = await timedFetch(
          fetchFn,
          signedUrl,
          {
            method: 'PUT',
            headers: { 'content-type': input.mime },
            body: input.bytes as Uint8Array<ArrayBuffer>,
          },
          60_000,
        );
        if (!up.ok) return err(name, `upload HTTP ${up.status}`);
        const deadline = Date.now() + opts.maxWaitMs;
        for (;;) {
          const r = await timedFetch(
            fetchFn,
            `${base}/api/media/users/${encodeURIComponent(requestId)}`,
            { headers: { 'X-API-KEY': apiKey } },
            15_000,
          );
          if (!r.ok) return err(name, `result HTTP ${r.status}`);
          const parsed = parseRealityDefenderResult((await r.json()) as RealityDefenderResult);
          if (parsed) return parsed;
          if (Date.now() >= deadline)
            return {
              name,
              status: 'skipped',
              detail: `Analysis still running after ${opts.maxWaitMs}ms (requestId ${requestId})`,
              verified: false,
            };
          await sleep(opts.pollMs ?? 2_000);
        }
      } catch (e) {
        return err(name, e);
      }
    },
  };
}

/** Returns null while the analysis is still running. */
export function parseRealityDefenderResult(body: RealityDefenderResult): DetectorResult | null {
  const name = 'reality_defender';
  const status = (body.resultsSummary?.status ?? body.overallStatus ?? '').toUpperCase();
  if (!status || status === 'ANALYZING' || status === 'PROCESSING' || status === 'PENDING') return null;
  const score = body.resultsSummary?.metadata?.finalScore;
  if (status === 'NOT_APPLICABLE' || status === 'UNABLE_TO_EVALUATE')
    return { name, status: 'ok', detail: status, verified: false };
  let p = typeof score === 'number' ? score / 100 : undefined;
  if (p === undefined)
    p = status === 'FAKE' ? 0.9 : status === 'SUSPICIOUS' ? 0.6 : status === 'AUTHENTIC' ? 0.1 : undefined;
  return { name, status: 'ok', aiProbability: p, detail: status, verified: false };
}
