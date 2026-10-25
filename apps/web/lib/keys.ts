import 'server-only';
import { coreSchema } from '@ok/core';
import { and, eq, isNull } from 'drizzle-orm';
import { platform } from './platform';

/**
 * Change (or remove) a key's spending cap. `@ok/core` has no update method
 * for keys yet, so this writes the core table directly (same shared schema).
 * TODO(core): move to `Core.updateApiKey()`.
 */
export async function setKeySpendLimit(
  orgId: string,
  keyId: string,
  spendLimitMicros: number | null,
): Promise<boolean> {
  const { core } = await platform();
  const k = coreSchema.apiKeys;
  const rows = await core.database
    .update(k)
    .set({ spendLimitMicros })
    .where(and(eq(k.id, keyId), eq(k.orgId, orgId), isNull(k.revokedAt)))
    .returning({ id: k.id });
  return rows.length > 0;
}

/** Key fields safe to send to the browser (never the hash). */
export interface KeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  spendLimitMicros: number | null;
  spentMicros: number;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export async function listKeyViews(orgId: string): Promise<KeyView[]> {
  const { core } = await platform();
  const keys = await core.listApiKeys(orgId);
  return keys.map((k) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: k.scopes,
    spendLimitMicros: k.spendLimitMicros,
    spentMicros: k.spentMicros,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    revokedAt: k.revokedAt?.toISOString() ?? null,
    createdAt: k.createdAt.toISOString(),
  }));
}
