import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '@ok/shared';
import type { GitHubApp } from './github/types';
import type { InstallationRow, Store } from './store';

/**
 * Stateless, HMAC-signed "setup state" tokens that bind a GitHub App install flow
 * to the org that started it: `v1.<base64url(json{o,e,n})>.<base64url(hmac)>`.
 */
export class LinkStateSigner {
  constructor(
    private readonly secret: string,
    private readonly ttlMs = 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {
    if (secret.length < 16) throw new Error('Link state secret must be at least 16 characters');
  }

  issue(orgId: string): { state: string; expiresAt: Date } {
    const exp = this.now() + this.ttlMs;
    const body = Buffer.from(
      JSON.stringify({ o: orgId, e: exp, n: randomBytes(8).toString('base64url') }),
    ).toString('base64url');
    return { state: `v1.${body}.${this.sign(body)}`, expiresAt: new Date(exp) };
  }

  /** Returns the org id if the token is authentic and unexpired, else null. */
  verify(state: string | null | undefined): { orgId: string } | null {
    if (!state) return null;
    const [version, body, sig] = state.split('.');
    if (version !== 'v1' || !body || !sig) return null;
    const expected = Buffer.from(this.sign(body));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
        o?: unknown;
        e?: unknown;
      };
      if (typeof data.o !== 'string' || typeof data.e !== 'number' || data.e < this.now()) return null;
      return { orgId: data.o };
    } catch {
      return null;
    }
  }

  private sign(body: string) {
    return createHmac('sha256', this.secret).update(`review-link:${body}`).digest('base64url');
  }
}

export interface LinkOptions {
  /**
   * Without OAuth verification an installation can only be claimed within this
   * window after its last installation webhook (install / repo selection change),
   * which only the installation's owner can trigger.
   */
  linkWindowMs: number;
  now?: () => number;
}

/**
 * Link a GitHub installation to an org (who pays for its reviews and sees them in
 * the console). Ownership is proven by an OAuth code when the app has OAuth
 * credentials; otherwise by recency of the installation's own webhook activity.
 */
export async function linkInstallation(
  deps: { store: Store; github: GitHubApp | null },
  input: { installationId: number; orgId: string; oauthCode?: string | null },
  opts: LinkOptions,
): Promise<InstallationRow> {
  const { store, github } = deps;
  const now = opts.now ?? Date.now;
  let inst = await store.getInstallation(input.installationId);
  if (!inst && github) {
    // The webhook may not have reached us (or arrived before this service existed).
    const info = await github.getInstallation(input.installationId);
    if (info) {
      inst = await store.upsertInstallation({
        id: info.id,
        accountLogin: info.accountLogin,
        accountType: info.accountType,
        accountId: info.accountId,
        eventAt: info.createdAt ? new Date(info.createdAt) : null,
      });
      const repos = await github
        .installation(info.id)
        .listRepositories()
        .catch(() => []);
      await store.upsertRepos(info.id, repos);
    }
  }
  if (!inst || inst.status === 'deleted') {
    throw new AppError('not_found', 'Unknown GitHub installation. Install the GitHub App first, then retry.');
  }
  if (inst.orgId === input.orgId) return inst;
  if (inst.orgId)
    throw new AppError('conflict', 'This installation is already linked to another organization');

  if (input.oauthCode && github?.userCanAccessInstallation) {
    const ok = await github.userCanAccessInstallation(input.oauthCode, input.installationId);
    if (!ok) throw new AppError('forbidden', 'Your GitHub account cannot access this installation');
  } else if (!inst.lastEventAt || now() - inst.lastEventAt.getTime() > opts.linkWindowMs) {
    throw new AppError(
      'forbidden',
      'This installation can no longer be linked without verification. Re-open the app installation on GitHub (Configure → Save) from the console link, then retry.',
    );
  }
  return store.linkInstallation(input.installationId, input.orgId);
}
