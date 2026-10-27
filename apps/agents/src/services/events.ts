import type { Db } from '@minh/db';
import { newId } from '@minh/shared';
import { desc, eq } from 'drizzle-orm';
import { agentEvents } from '../db/schema';
import type { Clock } from '../lib/time';

export type EventLevel = 'info' | 'warn' | 'error';

/** Durable per-agent event log (lifecycle, billing, budget, blocked senders, errors). */
export class EventLog {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async record(
    agent: { id: string; orgId: string },
    level: EventLevel,
    type: string,
    message: string,
    data?: Record<string, unknown>,
  ) {
    await this.db.insert(agentEvents).values({
      id: newId('evt'),
      orgId: agent.orgId,
      agentId: agent.id,
      level,
      type,
      message,
      data: data ?? null,
      createdAt: this.clock.now(),
    });
  }

  list(agentId: string, limit = 50) {
    return this.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.agentId, agentId))
      .orderBy(desc(agentEvents.createdAt))
      .limit(limit);
  }
}
