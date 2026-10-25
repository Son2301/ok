import type { Db } from '@ok/db';
import type { ToolDefinition } from '@ok/llm';
import { AppError, type Logger, newId } from '@ok/shared';
import type { AgentRow, TrustLevel } from '../db/schema';
import { approvals, toolCalls } from '../db/schema';
import {
  defaultTrust,
  type IntegrationCatalog,
  type IntegrationSpec,
  jsonSchemaOf,
  requiresCredentials,
  type ToolContext,
  type ToolServices,
  type ToolSpec,
} from '../integrations';
import type { FetchLike } from '../lib/http';
import { truncate } from '../lib/text';
import type { Clock } from '../lib/time';
import type { ToolOutcome } from '../runtime/types';
import type { CredentialStore } from './credentials';

export type ToolSource = 'inline' | 'proxy' | 'mcp' | 'approval';

export interface ResolvedTool {
  integration: IntegrationSpec;
  tool: ToolSpec;
  /** Trust level used for exposure (calls may still escalate, e.g. http_request POST). */
  trust: TrustLevel;
  definition: ToolDefinition;
}

export interface ExecuteOptions {
  conversationId?: string | null;
  toolCallId?: string | null;
  source: ToolSource;
  signal?: AbortSignal;
  /** Execute even if the trust level is `approve`/`draft` (owner approved the action). */
  bypassTrust?: boolean;
}

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const TRACE_RESULT_MAX = 20_000;

const TRUST_SUFFIX: Partial<Record<TrustLevel, string>> = {
  approve:
    ' [Requires owner approval: calling it queues the action for review instead of doing it immediately.]',
  draft: ' [Draft mode: calling it only saves a draft for the owner; nothing is sent or changed.]',
};

function traceValue(v: unknown): unknown {
  if (v === undefined) return null;
  const s = JSON.stringify(v);
  if (s === undefined) return null;
  return s.length <= TRACE_RESULT_MAX ? v : { truncated: true, preview: truncate(s, TRACE_RESULT_MAX) };
}

/**
 * Tool registry + executor. Every tool call — from the inline loop, a
 * container (tool proxy), an MCP client or an approved action — runs here, in
 * the control plane, where credentials live. Applies per-tool trust levels
 * (`off | draft | approve | auto`) and records a trace for each call.
 */
export class ToolService {
  constructor(
    private readonly deps: {
      db: Db;
      catalog: IntegrationCatalog;
      credentials: CredentialStore;
      services: ToolServices;
      fetch: FetchLike;
      clock: Clock;
      timezone: string;
      logger: Logger;
    },
  ) {}

  private enabledFor(agent: AgentRow, integration: IntegrationSpec): boolean {
    return Boolean(integration.alwaysEnabled || agent.integrations?.[integration.id]?.enabled);
  }

  trustFor(agent: AgentRow, integration: IntegrationSpec, tool: ToolSpec, args?: unknown): TrustLevel {
    return agent.integrations?.[integration.id]?.tools?.[tool.name] ?? defaultTrust(integration, tool, args);
  }

  /** Tools the agent can see: integration enabled, credentials present when required, trust ≠ off. */
  async resolve(agent: AgentRow): Promise<ResolvedTool[]> {
    const configured = await this.deps.credentials.listMasked(agent.id);
    const out: ResolvedTool[] = [];
    for (const integration of this.deps.catalog.integrations) {
      if (!this.enabledFor(agent, integration)) continue;
      if (requiresCredentials(integration) && !configured.has(integration.id)) continue;
      for (const tool of integration.tools) {
        const trust = this.trustFor(agent, integration, tool);
        if (trust === 'off') continue;
        out.push({
          integration,
          tool,
          trust,
          definition: {
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description + (TRUST_SUFFIX[trust] ?? ''),
              parameters: jsonSchemaOf(tool.args),
            },
          },
        });
      }
    }
    return out;
  }

  /** Tool names whose calls must not run concurrently (anything that is not a pure read). */
  static sequentialNames(resolved: ResolvedTool[]): string[] {
    return resolved
      .filter((r) => typeof r.tool.risk === 'function' || r.tool.risk !== 'read')
      .map((r) => r.tool.name);
  }

  async execute(
    agent: AgentRow,
    name: string,
    rawArgs: unknown,
    opts: ExecuteOptions,
  ): Promise<ToolOutcome & { approvalId?: string }> {
    const started = Date.now();
    const found = this.deps.catalog.findTool(name);
    const finish = async (
      outcome: ToolOutcome & { approvalId?: string },
      args: unknown,
      integrationId: string | null,
    ) => {
      await this.trace(agent, name, integrationId, args, outcome, opts).catch((err) =>
        this.deps.logger.error('tool_trace_failed', { err: (err as Error).message }),
      );
      return outcome;
    };
    if (!found || !this.enabledFor(agent, found.integration)) {
      return finish(
        { ok: false, outcome: 'denied', error: `Tool ${name} is not enabled for this agent`, durationMs: 0 },
        rawArgs,
        found?.integration.id ?? null,
      );
    }
    const { integration, tool } = found;
    const parsed = tool.args.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`)
        .join('; ');
      return finish(
        {
          ok: false,
          outcome: 'error',
          error: `Invalid arguments for ${name}: ${issues}`,
          durationMs: Date.now() - started,
        },
        rawArgs,
        integration.id,
      );
    }
    const args = parsed.data;

    if (!opts.bypassTrust) {
      const trust = this.trustFor(agent, integration, tool, args);
      if (trust === 'off') {
        return finish(
          { ok: false, outcome: 'denied', error: `Tool ${name} is turned off for this agent`, durationMs: 0 },
          args,
          integration.id,
        );
      }
      if (trust === 'approve' || trust === 'draft') {
        const approvalId = newId('apr');
        await this.deps.db.insert(approvals).values({
          id: approvalId,
          orgId: agent.orgId,
          agentId: agent.id,
          conversationId: opts.conversationId ?? null,
          toolCallId: opts.toolCallId ?? null,
          tool: name,
          integrationId: integration.id,
          arguments: args,
          mode: trust,
          status: trust === 'approve' ? 'pending' : 'drafted',
          createdAt: this.deps.clock.now(),
        });
        const result =
          trust === 'approve'
            ? {
                status: 'pending_approval',
                approvalId,
                message:
                  'This action needs approval from the business owner. It has been queued and will run once approved. Tell the user it is awaiting review — do not say it has been done.',
              }
            : {
                status: 'drafted',
                approvalId,
                message: 'Saved as a draft for the business owner to review. Nothing was sent or changed.',
              };
        return finish(
          {
            ok: true,
            outcome: trust === 'approve' ? 'pending_approval' : 'drafted',
            result,
            approvalId,
            durationMs: Date.now() - started,
          },
          args,
          integration.id,
        );
      }
    }

    try {
      const result = await this.invoke(agent, integration, tool, args, opts);
      return finish(
        { ok: true, outcome: 'executed', result, durationMs: Date.now() - started },
        args,
        integration.id,
      );
    } catch (err) {
      const message = err instanceof AppError ? err.message : `${name} failed: ${(err as Error).message}`;
      return finish(
        { ok: false, outcome: 'error', error: message, durationMs: Date.now() - started },
        args,
        integration.id,
      );
    }
  }

  private async invoke(
    agent: AgentRow,
    integration: IntegrationSpec,
    tool: ToolSpec,
    args: unknown,
    opts: ExecuteOptions,
  ): Promise<unknown> {
    const stored = (await this.deps.credentials.get(agent, integration.id)) ?? {};
    const creds = integration.authSchema.safeParse(stored);
    if (!creds.success)
      throw new AppError(
        'bad_request',
        `${integration.name} credentials are missing or invalid. Ask the owner to reconnect ${integration.name}.`,
      );
    const timeoutMs = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const ctx: ToolContext = {
      orgId: agent.orgId,
      agent,
      conversationId: opts.conversationId ?? null,
      credentials: creds.data as Record<string, unknown>,
      config: agent.integrations?.[integration.id]?.config ?? {},
      fetch: this.deps.fetch,
      signal,
      now: () => this.deps.clock.now(),
      timezone: agent.settings?.timezone ?? this.deps.timezone,
      services: this.deps.services,
      saveCredentials: async (patch) => {
        await this.deps.credentials.set(agent, integration, patch as Record<string, unknown>, {
          merge: true,
        });
      },
      logger: this.deps.logger.child({ agentId: agent.id, tool: tool.name }),
    };
    return await Promise.race([
      tool.handler(ctx, args),
      new Promise((_, reject) => {
        if (signal.aborted) reject(new AppError('timeout', `${tool.name} timed out`));
        signal.addEventListener(
          'abort',
          () => reject(new AppError('timeout', `${tool.name} timed out after ${timeoutMs}ms`)),
          { once: true },
        );
      }),
    ]);
  }

  private async trace(
    agent: AgentRow,
    name: string,
    integrationId: string | null,
    args: unknown,
    outcome: ToolOutcome,
    opts: ExecuteOptions,
  ) {
    await this.deps.db.insert(toolCalls).values({
      id: newId('tcl'),
      orgId: agent.orgId,
      agentId: agent.id,
      conversationId: opts.conversationId ?? null,
      toolCallId: opts.toolCallId ?? null,
      tool: name,
      integrationId,
      arguments: traceValue(args),
      result: outcome.ok ? traceValue(outcome.result) : null,
      ok: outcome.ok,
      outcome: outcome.outcome,
      error: outcome.error ?? null,
      durationMs: outcome.durationMs,
      source: opts.source,
      createdAt: this.deps.clock.now(),
    });
  }

  /** For status/integration views: per-tool effective trust for one integration. */
  toolSettings(agent: AgentRow, integration: IntegrationSpec) {
    return integration.tools.map((t) => ({
      name: t.name,
      risk: typeof t.risk === 'string' ? t.risk : 'depends_on_arguments',
      defaultTrust: defaultTrust(integration, t),
      trust: this.trustFor(agent, integration, t),
    }));
  }
}
