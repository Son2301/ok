import { z } from 'zod';
import type { CheckKind } from '../verdict/types';

/** Per-check prices for API-key callers, in micro-USD (1_000 = $0.001). Override with SAFE_PRICES. */
export const DEFAULT_PRICES: Record<CheckKind, number> = {
  url: 1_000,
  text: 1_000,
  phone: 1_000,
  bank_account: 1_000,
  email: 1_000,
  ai_text: 2_000,
  image: 10_000,
  video: 10_000,
  audio: 10_000,
};

const overrideSchema = z.record(z.string(), z.number().int().min(0).max(100_000_000));

export function resolvePrices(json?: string): Record<CheckKind, number> {
  if (!json) return { ...DEFAULT_PRICES };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('SAFE_PRICES must be a JSON object, e.g. {"url":1000}');
  }
  const o = overrideSchema.parse(parsed);
  const out = { ...DEFAULT_PRICES };
  for (const [k, v] of Object.entries(o)) {
    if (!(k in out)) throw new Error(`SAFE_PRICES: unknown check kind "${k}"`);
    out[k as CheckKind] = v;
  }
  return out;
}
