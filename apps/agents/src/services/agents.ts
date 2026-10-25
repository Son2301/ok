import type { Db } from '@ok/db';
import { AppError, formatUsd, type Logger, newId } from '@ok/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { AgentsConfig, PlanId, RuntimeId } from '../config';
import {
  type AgentIntegrationSetting,
  type AgentRow,
  type AgentSettings,
  type AgentStatus,
  agents,
  type TrustLevel,
} from '../db/schema';
import type { IntegrationCatalog, IntegrationSpec } from '../integrations';
import { requiresCredentials, TRUST_LEVELS } from '../integrations';
import type { BackgroundTasks } from '../lib/async';
import type { Clock } from '../lib/time';
import type { RuntimeDriver, RuntimeStatus } from '../runtime/drivers/types';
import type { BillingService } from './billing';
import type { CredentialStore } from './credentials';
import type { EventLog } from './events';
import type { RuntimeTokenService } from './tokens';
import type { ToolService } from './tools';
import type { LlmBroker, UsageService } from './usage';

export interface AgentInput {
  name: string;
  avatarUrl?: string | null;
  role?: string;
  jobDescription?: string;
  model?: string;
  runtime?: RuntimeId;
  plan?: PlanId;
  integrations?: Record<
    string,
    { enabled?: boolean; config?: Record<string, unknown>; tools?: Record<string, TrustLevel> }
  >;
  settings?: AgentSettings;
  reportsTo?: string | null;
  budgetMonthlyMicros?: number | null;
}

export interface IntegrationUpdate {
  enabled?: boolean;
  config?: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  tools?: Record<string, TrustLevel>;
}

export function serializeAgent(a: AgentRow) {
  return {
    id: a.id,
    orgId: a.orgId,
    name: a.name,
    avatarUrl: a.avatarUrl,
    role: a.role,
    jobDescription: a.jobDescription,
    model: a.model,
    runtime: a.runtime,
    plan: a.plan,
    integrations: a.integrations,
    settings: a.settings,
    reportsTo: a.reportsTo,
    budgetMonthlyMicros: a.budgetMonthlyMicros,
    status: a.status,
    statusReason: a.statusReason,
    deployedAt: a.deployedAt?.toISOString() ?? null,
    lastHeartbeatAt: a.lastHeartbeatAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

/** Agents CRUD, integration settings and lifecycle (deploy/start/stop/restart/delete) through the runtime driver. */
export class AgentService {
  constructor(
    private readonly deps: {
      db: Db;
      driver: RuntimeDriver;
      tokens: RuntimeTokenService;
      billing: BillingService;
      usage: UsageService;
      broker: LlmBroker;
      events: EventLog;
      catalog: IntegrationCatalog;
      credentials: CredentialStore;
      tools: ToolService;
      config: AgentsConfig;
      clock: Clock;
      bg: BackgroundTasks;
      logger: Logger;
    },
  ) {}

  private get db() {
    return this.deps.db;
  }

  // ------------------------------------------------------------------ CRUD

  async get(orgId: string, id: string): Promise<AgentRow> {
    const [row] = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.orgId, orgId)));
    if (!row) throw new AppError('not_found', 'Agent not found');
    return row;
  }

  async getById(id: string): Promise<AgentRow | null> {
    const [row] = await this.db.select().from(agents).where(eq(agents.id, id));
    return row ?? null;
  }

  list(orgId: string) {
    return this.db.select().from(agents).where(eq(agents.orgId, orgId)).orderBy(asc(agents.createdAt));
  }

  listByStatus(statuses: AgentStatus[]) {
    return this.db.select().from(agents).where(inArray(agents.status, statuses));
  }

  private normalizeIntegrations(
    input: NonNullable<AgentInput['integrations']>,
    current: Record<string, AgentIntegrationSetting> = {},
  ): Record<string, AgentIntegrationSetting> {
    const out: Record<string, AgentIntegrationSetting> = { ...current };
    for (const [id, setting] of Object.entries(input)) {
      const integration = this.deps.catalog.get(id);
      if (!integration)
        throw new AppError('bad_request', `Unknown integration "${id}". See GET /v1/integrations.`);
      out[id] = this.mergeSetting(integration, out[id], setting);
    }
    return out;
  }

  private mergeSetting(
    integration: IntegrationSpec,
    current: AgentIntegrationSetting | undefined,
    update: Omit<IntegrationUpdate, 'credentials'>,
  ): AgentIntegrationSetting {
    let config = current?.config ?? {};
    if (update.config !== undefined) {
      if (!integration.configSchema) {
        if (Object.keys(update.config).length)
          throw new AppError('bad_request', `${integration.name} has no configuration options`);
      } else {
        const parsed = integration.configSchema.safeParse(update.config);
        if (!parsed.success) {
          throw new AppError(
            'bad_request',
            `Invalid config for ${integration.name}`,
            parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          );
        }
        config = parsed.data as Record<string, unknown>;
      }
    }
    let tools = current?.tools;
    if (update.tools) {
      tools = { ...(tools ?? {}) };
      for (const [name, trust] of Object.entries(update.tools)) {
        if (!integration.tools.some((t) => t.name === name))
          throw new AppError('bad_request', `${integration.name} has no tool "${name}"`);
        if (!(TRUST_LEVELS as readonly string[]).includes(trust))
          throw new AppError(
            'bad_request',
            `Invalid trust level "${trust}" (use off, draft, approve or auto)`,
          );
        tools[name] = trust;
      }
    }
    return { enabled: update.enabled ?? current?.enabled ?? true, config, ...(tools ? { tools } : {}) };
  }

  /** reportsTo must be another agent in the same org, without creating a cycle. */
  private async validateReportsTo(
    orgId: string,
    agentId: string | null,
    reportsTo: string | null | undefined,
  ) {
    if (!reportsTo) return;
    if (reportsTo === agentId) throw new AppError('bad_request', 'An agent cannot report to itself');
    const all = await this.db
      .select({ id: agents.id, reportsTo: agents.reportsTo })
      .from(agents)
      .where(eq(agents.orgId, orgId));
    const byId = new Map(all.map((a) => [a.id, a.reportsTo]));
    if (!byId.has(reportsTo))
      throw new AppError('bad_request', 'reportsTo must be an agent in your organization');
    let cur: string | null | undefined = reportsTo;
    for (let i = 0; cur && i < 1000; i++) {
      if (cur === agentId) throw new AppError('bad_request', 'This reporting line would create a cycle');
      cur = byId.get(cur);
    }
  }

  async create(orgId: string, input: AgentInput): Promise<AgentRow> {
    await this.validateReportsTo(orgId, null, input.reportsTo);
    const now = this.deps.clock.now();
    const [row] = await this.db
      .insert(agents)
      .values({
        id: newId('agt'),
        orgId,
        name: input.name,
        avatarUrl: input.avatarUrl ?? null,
        role: input.role ?? 'Assistant',
        jobDescription: input.jobDescription ?? '',
        model: input.model ?? 'auto',
        runtime: input.runtime ?? 'builtin',
        plan: input.plan ?? 'starter',
        integrations: input.integrations ? this.normalizeIntegrations(input.integrations) : {},
        settings: input.settings ?? {},
        reportsTo: input.reportsTo ?? null,
        budgetMonthlyMicros: input.budgetMonthlyMicros ?? null,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return row!;
  }

  async update(
    orgId: string,
    id: string,
    patch: Partial<AgentInput>,
  ): Promise<{ agent: AgentRow; requiresRedeploy: boolean }> {
    const current = await this.get(orgId, id);
    if (patch.reportsTo !== undefined) await this.validateReportsTo(orgId, id, patch.reportsTo);
    const set: Partial<typeof agents.$inferInsert> = { updatedAt: this.deps.clock.now() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.avatarUrl !== undefined) set.avatarUrl = patch.avatarUrl;
    if (patch.role !== undefined) set.role = patch.role;
    if (patch.jobDescription !== undefined) set.jobDescription = patch.jobDescription;
    if (patch.model !== undefined) set.model = patch.model;
    if (patch.runtime !== undefined) set.runtime = patch.runtime;
    if (patch.plan !== undefined) set.plan = patch.plan;
    if (patch.settings !== undefined) set.settings = { ...current.settings, ...patch.settings };
    if (patch.reportsTo !== undefined) set.reportsTo = patch.reportsTo;
    if (patch.budgetMonthlyMicros !== undefined) set.budgetMonthlyMicros = patch.budgetMonthlyMicros;
    if (patch.integrations !== undefined)
      set.integrations = this.normalizeIntegrations(patch.integrations, current.integrations);
    const [row] = await this.db.update(agents).set(set).where(eq(agents.id, id)).returning();
    const requiresRedeploy =
      current.status === 'running' &&
      this.deps.driver.name === 'docker' &&
      ((patch.runtime && patch.runtime !== current.runtime) || (patch.plan && patch.plan !== current.plan));
    return { agent: row!, requiresRedeploy: Boolean(requiresRedeploy) };
  }

  async delete(orgId: string, id: string): Promise<void> {
    const agent = await this.get(orgId, id);
    try {
      await this.deps.driver.remove(agent.id);
    } catch (err) {
      this.deps.logger.warn('driver_remove_failed', { agentId: agent.id, err: (err as Error).message });
    }
    await this.deps.tokens.revokeAll(agent.id);
    await this.db.delete(agents).where(eq(agents.id, agent.id));
  }

  // ------------------------------------------------------------------ integrations

  async setIntegration(orgId: string, agentId: string, integrationId: string, input: IntegrationUpdate) {
    const agent = await this.get(orgId, agentId);
    const integration = this.deps.catalog.get(integrationId);
    if (!integration) throw new AppError('not_found', `Unknown integration "${integrationId}"`);
    if (input.credentials && Object.keys(input.credentials).length) {
      await this.deps.credentials.set(agent, integration, input.credentials, { merge: true });
    }
    const current = agent.integrations[integrationId];
    const next = this.mergeSetting(integration, current, {
      enabled: integration.alwaysEnabled ? true : (input.enabled ?? current?.enabled ?? true),
      config: input.config,
      tools: input.tools,
    });
    const [row] = await this.db
      .update(agents)
      .set({
        integrations: { ...agent.integrations, [integrationId]: next },
        updatedAt: this.deps.clock.now(),
      })
      .where(eq(agents.id, agentId))
      .returning();
    return this.integrationView(row!, integration);
  }

  async removeIntegration(orgId: string, agentId: string, integrationId: string) {
    const agent = await this.get(orgId, agentId);
    await this.deps.credentials.delete(agent.id, integrationId);
    const { [integrationId]: _removed, ...rest } = agent.integrations;
    await this.db
      .update(agents)
      .set({ integrations: rest, updatedAt: this.deps.clock.now() })
      .where(eq(agents.id, agentId));
  }

  /** Integration state for the owner: never contains secrets, only masked previews. */
  async integrationView(
    agent: AgentRow,
    integration: IntegrationSpec,
    masked?: Map<string, { masked: Record<string, string>; updatedAt: Date }>,
  ) {
    const creds = (masked ?? (await this.deps.credentials.listMasked(agent.id))).get(integration.id);
    const setting = agent.integrations[integration.id];
    const enabled = Boolean(integration.alwaysEnabled || setting?.enabled);
    const needsCreds = requiresCredentials(integration);
    return {
      integrationId: integration.id,
      name: integration.name,
      category: integration.category,
      verified: integration.verified,
      status: integration.status,
      enabled,
      ready: enabled && (!needsCreds || Boolean(creds)) && integration.status === 'available',
      config: setting?.config ?? {},
      tools: this.deps.tools.toolSettings(agent, integration),
      credentials: {
        configured: Boolean(creds),
        fields: creds?.masked ?? {},
        updatedAt: creds?.updatedAt.toISOString() ?? null,
      },
    };
  }

  async integrationViews(agent: AgentRow) {
    const masked = await this.deps.credentials.listMasked(agent.id);
    const ids = new Set([...Object.keys(agent.integrations), ...masked.keys()]);
    const list = this.deps.catalog.integrations.filter((i) => i.alwaysEnabled || ids.has(i.id));
    return Promise.all(list.map((i) => this.integrationView(agent, i, masked)));
  }

  // ------------------------------------------------------------------ lifecycle

  private async setStatus(
    agent: AgentRow,
    status: AgentStatus,
    reason: string | null,
    extra: Partial<typeof agents.$inferInsert> = {},
  ): Promise<AgentRow> {
    const [row] = await this.db
      .update(agents)
      .set({ status, statusReason: reason, updatedAt: this.deps.clock.now(), ...extra })
      .where(eq(agents.id, agent.id))
      .returning();
    return row!;
  }

  private async assertBudgetAvailable(agent: AgentRow) {
    const { blocked, spentMicros } = await this.deps.broker.budgetBlocked(agent);
    if (blocked) {
      throw new AppError(
        'payment_required',
        `Monthly budget used up (${formatUsd(spentMicros)} of ${formatUsd(agent.budgetMonthlyMicros ?? 0)}). Raise budgetMonthlyMicros to start the agent.`,
      );
    }
  }

  /** Create (or recreate) the runtime with a fresh runtime token. Does not charge. */
  private async provision(agent: AgentRow): Promise<{ agent: AgentRow; runtime: RuntimeStatus }> {
    let row = await this.setStatus(agent, 'deploying', null);
    try {
      const { token } = await this.deps.tokens.rotateContainerToken(row);
      const runtime = await this.deps.driver.deploy({
        agentId: row.id,
        orgId: row.orgId,
        runtime: row.runtime as RuntimeId,
        plan: this.deps.config.plans[row.plan as PlanId],
        runtimeToken: token,
      });
      if (runtime.state === 'error' || runtime.state === 'missing')
        throw new Error(runtime.detail ?? `runtime is ${runtime.state}`);
      row = await this.setStatus(row, 'running', null, { deployedAt: this.deps.clock.now() });
      await this.deps.events.record(
        row,
        'info',
        'deployed',
        `Deployed on ${this.deps.driver.name} driver (runtime ${row.runtime}, plan ${row.plan})`,
      );
      return { agent: row, runtime };
    } catch (err) {
      const message = (err as Error).message;
      await this.setStatus(row, 'error', message.slice(0, 500));
      await this.deps.events.record(row, 'error', 'deploy_failed', message.slice(0, 500));
      throw err instanceof AppError ? err : new AppError('upstream_error', `Deploy failed: ${message}`);
    }
  }

  async deploy(orgId: string, id: string) {
    const agent = await this.get(orgId, id);
    await this.assertBudgetAvailable(agent);
    await this.deps.billing.ensureChargedToday(agent);
    return this.provision(agent);
  }

  async start(orgId: string, id: string) {
    const agent = await this.get(orgId, id);
    if (agent.status === 'running') return { agent, runtime: await this.deps.driver.status(id) };
    await this.assertBudgetAvailable(agent);
    await this.deps.billing.ensureChargedToday(agent);
    if (!agent.deployedAt || agent.status === 'draft' || agent.status === 'error')
      return this.provision(agent);
    const runtime = await this.deps.driver.start(id);
    if (runtime.state === 'missing' || runtime.state === 'error') return this.provision(agent);
    const row = await this.setStatus(agent, 'running', null);
    await this.deps.events.record(row, 'info', 'started', 'Agent started');
    return { agent: row, runtime };
  }

  async stop(orgId: string, id: string) {
    const agent = await this.get(orgId, id);
    const runtime = await this.deps.driver.stop(id);
    const row = await this.setStatus(agent, 'stopped', null);
    await this.deps.events.record(row, 'info', 'stopped', 'Agent stopped by owner');
    return { agent: row, runtime };
  }

  async restart(orgId: string, id: string) {
    const agent = await this.get(orgId, id);
    if (agent.status === 'running') await this.deps.driver.stop(id);
    const row = agent.status === 'running' ? await this.setStatus(agent, 'stopped', null) : agent;
    return this.start(orgId, row.id);
  }

  async status(orgId: string, id: string, opts: { tail?: number } = {}) {
    const agent = await this.get(orgId, id);
    const runtime = await this.deps.driver
      .status(id)
      .catch((err: Error) => ({ state: 'unknown' as const, detail: err.message }));
    const logs = await this.deps.driver.logs(id, { tail: opts.tail ?? 100 }).catch(() => []);
    const events = await this.deps.events.list(id, 50);
    const usage = await this.deps.usage.get(id);
    const plan = this.deps.config.plans[agent.plan as PlanId];
    return {
      id: agent.id,
      status: agent.status,
      statusReason: agent.statusReason,
      driver: this.deps.driver.name,
      runtime,
      usage: {
        month: this.deps.usage.currentMonth(),
        totalTokens: usage?.totalTokens ?? 0,
        includedTokens: plan.monthlyTokens,
        platformTokens: usage?.platformTokens ?? 0,
        customerTokens: usage?.customerTokens ?? 0,
        customerCostMicros: usage?.customerCostMicros ?? 0,
        budgetMonthlyMicros: agent.budgetMonthlyMicros,
      },
      logs,
      events: events.map((e) => ({
        at: e.createdAt.toISOString(),
        level: e.level,
        type: e.type,
        message: e.message,
        data: e.data,
      })),
    };
  }

  /** Payment failed: stop the agent until the owner tops up and starts it again. */
  async suspendForBilling(agent: AgentRow, reason: string) {
    const row = await this.setStatus(agent, 'suspended_billing', reason);
    await this.deps.driver.stop(agent.id).catch(() => undefined);
    await this.deps.events.record(row, 'error', 'suspended_billing', reason);
    return row;
  }

  /** Budget cap reached: mark paused now (LLM calls are refused), stop the runtime in the background. */
  async pauseForBudget(agent: AgentRow, spentMicros: number) {
    const reason = `Monthly budget reached (${formatUsd(spentMicros)} of ${formatUsd(agent.budgetMonthlyMicros ?? 0)})`;
    const row = await this.setStatus(agent, 'paused_budget', reason);
    this.deps.bg.run(async () => {
      await this.deps.driver.stop(agent.id);
    });
    return row;
  }

  /** Resume an agent paused for budget once it is under budget again (new month or raised cap). */
  async resumeIfUnderBudget(agent: AgentRow): Promise<boolean> {
    if (agent.status !== 'paused_budget') return false;
    if ((await this.deps.broker.budgetBlocked(agent)).blocked) return false;
    try {
      await this.start(agent.orgId, agent.id);
      await this.deps.events.record(
        agent,
        'info',
        'budget_resumed',
        'Agent resumed: under its monthly budget again',
      );
      return true;
    } catch (err) {
      this.deps.logger.warn('budget_resume_failed', { agentId: agent.id, err: (err as Error).message });
      return false;
    }
  }

  /** On boot: make the runtime match the database (re-create inline agents, restart stopped containers). */
  async reconcile(): Promise<{ agentId: string; action: string }[]> {
    const actions: { agentId: string; action: string }[] = [];
    for (const agent of await this.listByStatus(['running', 'deploying'])) {
      try {
        const rt = await this.deps.driver.status(agent.id);
        if (rt.state === 'running' || rt.state === 'starting') continue;
        if (rt.state === 'stopped') {
          await this.deps.driver.start(agent.id);
          actions.push({ agentId: agent.id, action: 'started' });
        } else {
          await this.provision(agent);
          actions.push({ agentId: agent.id, action: 'redeployed' });
        }
      } catch (err) {
        actions.push({ agentId: agent.id, action: `failed: ${(err as Error).message}` });
      }
    }
    return actions;
  }

  async orgChart(orgId: string) {
    const all = await this.list(orgId);
    type Node = {
      id: string;
      name: string;
      role: string;
      status: string;
      avatarUrl: string | null;
      reportsTo: string | null;
      directReports: Node[];
    };
    const nodes = new Map<string, Node>(
      all.map((a) => [
        a.id,
        {
          id: a.id,
          name: a.name,
          role: a.role,
          status: a.status,
          avatarUrl: a.avatarUrl,
          reportsTo: a.reportsTo,
          directReports: [],
        },
      ]),
    );
    const roots: Node[] = [];
    for (const n of nodes.values()) {
      const parent = n.reportsTo ? nodes.get(n.reportsTo) : undefined;
      if (parent) parent.directReports.push(n);
      else roots.push(n);
    }
    return roots;
  }
}
