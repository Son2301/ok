import 'server-only';
import { platform } from './platform';

export async function renameOrg(orgId: string, name: string): Promise<void> {
  const { core } = await platform();
  await core.renameOrg(orgId, name);
}

export async function listMembers(orgId: string) {
  const { core } = await platform();
  return core.listMembers(orgId);
}
