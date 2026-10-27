import { createHash } from 'node:crypto';
import { AppError } from '@minh/shared';

export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function isPaymentError(err: unknown): boolean {
  return err instanceof AppError && err.code === 'payment_required';
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Transient errors worth retrying: upstream/timeouts/rate limits, network failures
 * and GitHub 5xx/429 (Octokit errors carry `status`).
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof AppError)
    return err.code === 'upstream_error' || err.code === 'timeout' || err.code === 'rate_limited';
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number') {
    if (status === 429 || status >= 500) return true;
    // GitHub secondary rate limits come back as 403 with a retry hint.
    const msg = errorMessage(err).toLowerCase();
    return status === 403 && msg.includes('rate limit');
  }
  const code = (err as { code?: unknown })?.code;
  if (
    typeof code === 'string' &&
    /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR_\w+)$/.test(code)
  )
    return true;
  return err instanceof TypeError && /fetch failed|network/i.test(err.message);
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/** Review costs are usually cents or less, so show 4 decimals under $1. */
export function formatCost(micros: number): string {
  const usd = micros / 1_000_000;
  return `$${usd.toFixed(Math.abs(usd) < 1 ? 4 : 2)}`;
}

export function currentPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}
