import { AppError } from './errors';

export interface FetchWithTimeoutInit extends RequestInit {
  timeoutMs?: number;
}

/** fetch() with a hard timeout that surfaces as AppError('timeout'). */
export async function fetchWithTimeout(
  url: string | URL,
  init: FetchWithTimeoutInit = {},
): Promise<Response> {
  const { timeoutMs = 30_000, signal, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(
    () =>
      ctrl.abort(new AppError('timeout', `Request to ${new URL(url).host} timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  const onAbort = () => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, { ...rest, signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted && ctrl.signal.reason instanceof AppError) throw ctrl.signal.reason;
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
