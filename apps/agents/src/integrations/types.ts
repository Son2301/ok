import { AppError, type Logger } from '@minh/shared';
import { z } from 'zod';
import type { AgentRow, TrustLevel } from '../db/schema';
import type { FetchLike } from '../lib/http';
import type { SafeFetchOptions, SafeResponse } from '../lib/ssrf';
import type { KnowledgeHit } from '../services/knowledge';
import type { TaskService } from '../services/tasks';

export type IntegrationCategory =
  | 'core'
  | 'team'
  | 'messaging'
  | 'commerce'
  | 'productivity'
  | 'accounting'
  | 'developer';

/**
 * What a tool does to the world. Drives the default trust level:
 * - `read`: lookups → `auto`
 * - `internal_write`: changes only platform data (tasks, reports) → `auto`
 * - `external_write`: sends, writes or spends in a third-party system → `approve`
 *   (`off` for commerce integrations, whose write tools must be explicitly enabled)
 */
export type ToolRisk = 'read' | 'internal_write' | 'external_write';

export const TRUST_LEVELS = ['off', 'draft', 'approve', 'auto'] as const satisfies readonly TrustLevel[];

/** Platform services a tool handler may use. */
export interface ToolServices {
  knowledge: {
    search(input: { orgId: string; agentId: string; query: string; limit: number }): Promise<KnowledgeHit[]>;
  };
  tasks: TaskService;
  safeFetch(url: string, opts: SafeFetchOptions): Promise<SafeResponse>;
}

export interface ToolContext<C = Record<string, unknown>, K = Record<string, unknown>> {
  orgId: string;
  agent: AgentRow;
  conversationId: string | null;
  /** Decrypted, schema-validated credentials. They never leave the control plane. */
  credentials: C;
  /** Non-secret per-agent integration config. */
  config: K;
  fetch: FetchLike;
  signal: AbortSignal;
  now(): Date;
  timezone: string;
  services: ToolServices;
  /** Persist refreshed credentials (e.g. a rotated OAuth access token). */
  saveCredentials(patch: Partial<C>): Promise<void>;
  logger: Logger;
}

// Handlers are typed per integration via toolBuilder<Ctx>(); the registry stores them type-erased.
// biome-ignore lint/suspicious/noExplicitAny: type-erased registry entry
export interface ToolSpec<Ctx = ToolContext<any, any>> {
  name: string;
  description: string;
  args: z.ZodType;
  /** Static risk, or computed from the arguments (e.g. `http_request` GET vs POST). */
  // biome-ignore lint/suspicious/noExplicitAny: arguments are validated by `args` before use
  risk: ToolRisk | ((args: any) => ToolRisk);
  /** Overrides the risk-derived default trust level. */
  defaultTrust?: TrustLevel;
  timeoutMs?: number;
  // biome-ignore lint/suspicious/noExplicitAny: arguments are validated by `args` before use
  handler(ctx: Ctx, args: any): Promise<unknown>;
}

/** Typed tool factory: `const tool = toolBuilder<Ctx>(); tool({ … handler: (ctx, args) => … })`. */
export function toolBuilder<Ctx>() {
  return <S extends z.ZodType>(def: {
    name: string;
    description: string;
    args: S;
    risk: ToolRisk | ((args: z.output<S>) => ToolRisk);
    defaultTrust?: TrustLevel;
    timeoutMs?: number;
    handler: (ctx: Ctx, args: z.output<S>) => Promise<unknown>;
  }): ToolSpec<Ctx> => def as ToolSpec<Ctx>;
}

export interface IntegrationSpec {
  id: string;
  name: string;
  category: IntegrationCategory;
  description: string;
  /** `true` only once tested against the real service (or for our own platform code). */
  verified: boolean;
  status: 'available' | 'coming_soon';
  docsUrl?: string;
  /** Enabled for every agent without configuration (core and team tools). */
  alwaysEnabled?: boolean;
  /** Secret credentials (encrypted at rest, never returned). */
  authSchema: z.ZodObject;
  /** Non-secret per-agent configuration. */
  configSchema?: z.ZodObject;
  /** Inbound channel powered by these credentials, if any. */
  channel?: 'telegram' | 'zalo';
  // biome-ignore lint/suspicious/noExplicitAny: each integration has its own credential/config types
  tools: ToolSpec<any>[];
}

export function defineIntegration<T extends IntegrationSpec>(spec: T): T {
  const names = new Set<string>();
  for (const t of spec.tools) {
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(t.name)) throw new Error(`Invalid tool name ${t.name}`);
    if (names.has(t.name)) throw new Error(`Duplicate tool ${t.name} in ${spec.id}`);
    names.add(t.name);
  }
  return spec;
}

export function riskOf(tool: ToolSpec, args?: unknown): ToolRisk {
  if (typeof tool.risk === 'string') return tool.risk;
  if (args === undefined) return 'read';
  try {
    return tool.risk(args);
  } catch {
    return 'external_write';
  }
}

/** Default trust for a tool call (or for exposure when `args` is undefined). */
export function defaultTrust(integration: IntegrationSpec, tool: ToolSpec, args?: unknown): TrustLevel {
  if (tool.defaultTrust) return tool.defaultTrust;
  const risk = riskOf(tool, args);
  if (risk === 'external_write') return integration.category === 'commerce' ? 'off' : 'approve';
  return 'auto';
}

/** JSON Schema (for OpenAI tools / MCP) generated from a zod schema. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

/** Whether the auth schema has required fields (i.e. credentials must be configured before tools work). */
export function requiresCredentials(spec: IntegrationSpec): boolean {
  return !spec.authSchema.safeParse({}).success;
}

/** Error for integrations that are listed but not available yet. Message is shown to the model and the owner. */
export class IntegrationUnavailableError extends AppError {
  constructor(integration: string, reason: string) {
    super('bad_request', `${integration} is not available yet: ${reason}`);
  }
}

/** Reject CR/LF to prevent header injection in values we put into protocol headers (email, etc.). */
export const singleLine = (max = 998) =>
  z
    .string()
    .max(max)
    .refine((s) => !/[\r\n]/.test(s), 'must be a single line');
