import type { Localized, Signal, SourceStatus } from './types';

export function signal(
  id: string,
  weight: number,
  label: Localized,
  source: string,
  evidence?: string,
): Signal {
  const w = Math.max(-100, Math.min(100, Math.round(weight)));
  return evidence
    ? { id, label, weight: w, evidence: evidence.slice(0, 500), source }
    : { id, label, weight: w, source };
}

/** Result of one evidence source (heuristic module or external API). */
export interface SourceResult<T = unknown> {
  name: string;
  status: SourceStatus['status'];
  detail?: string;
  signals: Signal[];
  data?: T;
}

export const skipped = (name: string, detail: string): SourceResult => ({
  name,
  status: 'skipped',
  detail,
  signals: [],
});
export const errored = (name: string, err: unknown): SourceResult => ({
  name,
  status: 'error',
  detail: (err instanceof Error ? err.message : String(err)).slice(0, 300),
  signals: [],
});

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** fetch with an injected implementation and a hard timeout. */
export async function timedFetch(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit = {},
  timeoutMs = 5_000,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error(`timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
