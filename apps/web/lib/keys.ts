import 'server-only';
import { isAppError } from '@ok/shared';
import { platform } from './platform';

/** Change (or remove) a key's spending cap. Returns false if the key is unknown or revoked. */
export async function setKeySpendLimit(
  orgId: string,
  keyId: string,
  spendLimitMicros: number | null,
): Promise<boolean> {
  const { core } = await platform();
  try {
    await core.updateApiKey(orgId, keyId, { spendLimitMicros });
    return true;
  } catch (err) {
    if (isAppError(err) && err.code === 'not_found') return false;
    throw err;
  }
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
