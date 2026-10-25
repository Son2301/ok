import type { Db } from '@ok/db';
import { AppError, newId } from '@ok/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { runtimeTokens } from '../db/schema';
import { generateToken, sha256Hex } from '../lib/crypto';
import type { Clock } from '../lib/time';

export const RUNTIME_TOKEN_PREFIX = 'agrt';

/**
 * Per-agent runtime tokens (stored as sha256 only). `container` tokens are
 * minted on every deploy and injected into the agent's container; `external`
 * tokens let the owner connect a self-hosted runtime or MCP client.
 * A token authorises: the tool proxy, the LLM proxy and the MCP endpoint — for that agent only.
 */
export class RuntimeTokenService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async issue(agent: { id: string; orgId: string }, kind: 'container' | 'external', label?: string) {
    const token = generateToken(RUNTIME_TOKEN_PREFIX);
    const [record] = await this.db
      .insert(runtimeTokens)
      .values({
        id: newId('rtk'),
        orgId: agent.orgId,
        agentId: agent.id,
        kind,
        label: label ?? null,
        tokenHash: sha256Hex(token),
        prefix: `${token.slice(0, 12)}…`,
        createdAt: this.clock.now(),
      })
      .returning();
    return { token, record: record! };
  }

  /** Revoke previous container tokens and mint a fresh one (on every deploy). */
  async rotateContainerToken(agent: { id: string; orgId: string }) {
    await this.db
      .update(runtimeTokens)
      .set({ revokedAt: this.clock.now() })
      .where(
        and(
          eq(runtimeTokens.agentId, agent.id),
          eq(runtimeTokens.kind, 'container'),
          isNull(runtimeTokens.revokedAt),
        ),
      );
    return this.issue(agent, 'container');
  }

  /** Hash of the active container token: the key the control plane signs runtime requests with. */
  async containerTokenHash(agentId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ tokenHash: runtimeTokens.tokenHash })
      .from(runtimeTokens)
      .where(
        and(
          eq(runtimeTokens.agentId, agentId),
          eq(runtimeTokens.kind, 'container'),
          isNull(runtimeTokens.revokedAt),
        ),
      )
      .orderBy(desc(runtimeTokens.createdAt))
      .limit(1);
    return row?.tokenHash ?? null;
  }

  /** Validate a bearer token for an agent. Returns null if invalid, revoked or for another agent. */
  async verify(agentId: string, token: string) {
    if (!token.startsWith(`${RUNTIME_TOKEN_PREFIX}_`)) return null;
    const [row] = await this.db
      .select()
      .from(runtimeTokens)
      .where(and(eq(runtimeTokens.tokenHash, sha256Hex(token)), isNull(runtimeTokens.revokedAt)));
    if (!row || row.agentId !== agentId) return null;
    const now = this.clock.now();
    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > 60_000) {
      void this.db
        .update(runtimeTokens)
        .set({ lastUsedAt: now })
        .where(eq(runtimeTokens.id, row.id))
        .catch(() => {});
    }
    return row;
  }

  list(agentId: string) {
    return this.db
      .select({
        id: runtimeTokens.id,
        kind: runtimeTokens.kind,
        label: runtimeTokens.label,
        prefix: runtimeTokens.prefix,
        lastUsedAt: runtimeTokens.lastUsedAt,
        revokedAt: runtimeTokens.revokedAt,
        createdAt: runtimeTokens.createdAt,
      })
      .from(runtimeTokens)
      .where(eq(runtimeTokens.agentId, agentId))
      .orderBy(desc(runtimeTokens.createdAt));
  }

  async revoke(agentId: string, tokenId: string) {
    const res = await this.db
      .update(runtimeTokens)
      .set({ revokedAt: this.clock.now() })
      .where(
        and(
          eq(runtimeTokens.id, tokenId),
          eq(runtimeTokens.agentId, agentId),
          isNull(runtimeTokens.revokedAt),
        ),
      )
      .returning({ id: runtimeTokens.id });
    if (!res.length) throw new AppError('not_found', 'Runtime token not found');
  }

  async revokeAll(agentId: string) {
    await this.db
      .update(runtimeTokens)
      .set({ revokedAt: this.clock.now() })
      .where(and(eq(runtimeTokens.agentId, agentId), isNull(runtimeTokens.revokedAt)));
  }
}
