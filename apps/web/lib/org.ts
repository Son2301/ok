import 'server-only';
import { coreSchema } from '@ok/core';
import { asc, eq } from 'drizzle-orm';
import { platform } from './platform';

/**
 * Org-level reads/writes that `@ok/core` doesn't expose yet. They touch only
 * the shared `core` schema. TODO(core): `Core.renameOrg()` and `Core.listMembers()`.
 */
export async function renameOrg(orgId: string, name: string): Promise<void> {
  const { core } = await platform();
  await core.database.update(coreSchema.orgs).set({ name }).where(eq(coreSchema.orgs.id, orgId));
}

export async function listMembers(orgId: string) {
  const { core } = await platform();
  const m = coreSchema.memberships;
  const u = coreSchema.users;
  return core.database
    .select({ userId: u.id, email: u.email, name: u.name, role: m.role, createdAt: u.createdAt })
    .from(m)
    .innerJoin(u, eq(u.id, m.userId))
    .where(eq(m.orgId, orgId))
    .orderBy(asc(u.createdAt));
}
