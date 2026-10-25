import type { Db } from '@ok/db';
import { AppError, newId } from '@ok/shared';
import { and, eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import { integrationCredentials } from '../db/schema';
import type { IntegrationSpec } from '../integrations/types';
import { maskRecord, type SecretBox } from '../lib/crypto';
import type { Clock } from '../lib/time';

/**
 * Integration credentials, encrypted at rest with AES-256-GCM. The AAD binds
 * each ciphertext to (org, agent, integration). Plaintext only exists in the
 * control plane while a tool runs; API responses carry the masked preview.
 */
export class CredentialStore {
  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
    private readonly clock: Clock,
  ) {}

  private aad(orgId: string, agentId: string, integrationId: string) {
    return `${orgId}:${agentId}:${integrationId}`;
  }

  /**
   * Store credentials. With `merge`, fields not provided keep their current
   * value (so a single token can be rotated); `null` clears a field.
   */
  async set(
    agent: { id: string; orgId: string },
    integration: IntegrationSpec,
    input: Record<string, unknown>,
    opts: { merge?: boolean } = {},
  ) {
    const current = opts.merge ? ((await this.get(agent, integration.id)) ?? {}) : {};
    const merged: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(input)) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = integration.authSchema.parse(merged) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof ZodError) {
        // Report which fields are wrong without echoing any submitted secret.
        throw new AppError(
          'bad_request',
          `Invalid credentials for ${integration.name}`,
          err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        );
      }
      throw err;
    }
    const masked = maskRecord(parsed);
    const ciphertext = this.box.encryptJson(parsed, this.aad(agent.orgId, agent.id, integration.id));
    const now = this.clock.now();
    await this.db
      .insert(integrationCredentials)
      .values({
        id: newId('crd'),
        orgId: agent.orgId,
        agentId: agent.id,
        integrationId: integration.id,
        ciphertext,
        keyId: this.box.keyId,
        masked,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [integrationCredentials.agentId, integrationCredentials.integrationId],
        set: { ciphertext, keyId: this.box.keyId, masked, updatedAt: now },
      });
    return { masked, updatedAt: now };
  }

  /** Decrypted credentials, or null if none are stored. */
  async get(
    agent: { id: string; orgId: string },
    integrationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [row] = await this.db
      .select()
      .from(integrationCredentials)
      .where(
        and(
          eq(integrationCredentials.agentId, agent.id),
          eq(integrationCredentials.integrationId, integrationId),
        ),
      );
    if (!row) return null;
    if (row.orgId !== agent.orgId) throw new AppError('forbidden', 'Credential owner mismatch');
    try {
      return this.box.decryptJson<Record<string, unknown>>(
        row.ciphertext,
        this.aad(row.orgId, row.agentId, row.integrationId),
      );
    } catch {
      throw new AppError(
        'internal',
        `Stored credentials for ${integrationId} cannot be decrypted (encryption key changed?). Re-enter them.`,
      );
    }
  }

  /** Masked previews for every integration that has credentials. */
  async listMasked(agentId: string) {
    const rows = await this.db
      .select({
        integrationId: integrationCredentials.integrationId,
        masked: integrationCredentials.masked,
        updatedAt: integrationCredentials.updatedAt,
      })
      .from(integrationCredentials)
      .where(eq(integrationCredentials.agentId, agentId));
    return new Map(rows.map((r) => [r.integrationId, { masked: r.masked, updatedAt: r.updatedAt }]));
  }

  async delete(agentId: string, integrationId: string) {
    await this.db
      .delete(integrationCredentials)
      .where(
        and(
          eq(integrationCredentials.agentId, agentId),
          eq(integrationCredentials.integrationId, integrationId),
        ),
      );
  }
}
