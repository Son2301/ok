import type { Dict } from './i18n';
import { fmt } from './i18n';

/** The subset of a core wallet entry the UI needs (serialisable to client components). */
export interface LedgerEntry {
  id: string;
  amountMicros: number;
  balanceAfterMicros: number;
  kind: string;
  product: string | null;
  apiKeyId: string | null;
  ref: string | null;
  description: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string | Date;
}

const PRODUCT_NAMES: Record<string, string> = {
  gateway: 'Gateway',
  agents: 'Agents',
  safe: 'Safe',
  review: 'Review',
};

export function productName(product: string | null | undefined, t: Dict): string {
  if (!product) return '—';
  return PRODUCT_NAMES[product] ?? t.products.other.name;
}

/** Human description of a ledger line, in the viewer's language where we can. */
export function describeEntry(e: LedgerEntry, t: Dict): string {
  if (e.kind === 'grant' && (!e.description || e.description === 'Welcome credit')) return t.ledger.welcome;
  if (e.kind === 'topup' && e.meta && typeof e.meta.amount_vnd === 'number') {
    return `${t.ledger.kind.topup} · VietQR`;
  }
  const model = e.meta && typeof e.meta.model === 'string' ? e.meta.model : null;
  if (model) {
    const provider = typeof e.meta?.provider === 'string' ? e.meta.provider : null;
    return provider ? `${model} · ${provider}` : model;
  }
  if (e.description) return e.description;
  if (e.product) return fmt(t.ledger.usageOf, { product: productName(e.product, t) });
  return (t.ledger.kind as Record<string, string>)[e.kind] ?? e.kind;
}

export function kindLabel(kind: string, t: Dict): string {
  return (t.ledger.kind as Record<string, string>)[kind] ?? kind;
}

/** Where the full receipt of the thing that caused this entry lives in the console, if anywhere. */
export function entrySourceHref(e: LedgerEntry): string | null {
  const ref = e.ref ?? '';
  if (ref.startsWith('gen_')) return `/console/gateway/requests/${encodeURIComponent(ref)}`;
  if (ref.startsWith('chk_')) return `/console/safe/checks/${encodeURIComponent(ref)}`;
  if (ref.startsWith('rev_')) return `/console/review/${encodeURIComponent(ref)}`;
  const agent = ref.match(/^agent:([^:]+):/);
  if (agent) return `/console/agents/${encodeURIComponent(agent[1]!)}`;
  return null;
}

export function toLedgerEntry(e: {
  id: string;
  amountMicros: number;
  balanceAfterMicros: number;
  kind: string;
  product: string | null;
  apiKeyId: string | null;
  ref: string | null;
  description: string | null;
  meta: Record<string, unknown> | null;
  createdAt: Date;
}): LedgerEntry {
  return {
    id: e.id,
    amountMicros: e.amountMicros,
    balanceAfterMicros: e.balanceAfterMicros,
    kind: e.kind,
    product: e.product,
    apiKeyId: e.apiKeyId,
    ref: e.ref,
    description: e.description,
    meta: e.meta,
    createdAt: e.createdAt.toISOString(),
  };
}
