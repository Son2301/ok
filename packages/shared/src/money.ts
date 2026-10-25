/**
 * All money is stored as integer micro-USD (1 USD = 1_000_000 µUSD) to avoid
 * floating point drift. Display conversion to VND happens at the edge.
 */
export const MICRO = 1_000_000;

export const usdToMicros = (usd: number): number => Math.round(usd * MICRO);
export const microsToUsd = (micros: number): number => micros / MICRO;

/** Cost of `tokens` at `pricePerMillionUsd`, in micro-USD (rounded up so we never undercharge by rounding). */
export function tokenCostMicros(tokens: number, pricePerMillionUsd: number): number {
  if (tokens <= 0 || pricePerMillionUsd <= 0) return 0;
  return Math.ceil(tokens * pricePerMillionUsd);
}

export const DEFAULT_VND_PER_USD = Number(process.env.VND_PER_USD ?? 26_000);

export function formatVnd(micros: number, rate = DEFAULT_VND_PER_USD): string {
  const vnd = Math.round(microsToUsd(micros) * rate);
  return `${vnd.toLocaleString('vi-VN')} ₫`;
}

export function formatUsd(micros: number, digitsOverride?: number): string {
  const usd = microsToUsd(micros);
  const digits = digitsOverride ?? (Math.abs(usd) < 0.01 && usd !== 0 ? 6 : 2);
  return `$${usd.toFixed(digits)}`;
}
