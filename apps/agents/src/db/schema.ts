import type { ToolCall } from '@ok/llm';
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/** Keep in sync with `migrations.ts` (hand-written SQL is the source of truth for the database). */
export const agentsSchema = pgSchema('agents');

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });
const ts = (name: string) => timestamp(name, { withTimezone: true });
const micros = (name: string) => bigint(name, { mode: 'number' });

export type AgentStatus =
  | 'draft'
  | 'deploying'
  | 'running'
  | 'stopped'
  | 'error'
  | 'suspended_billing'
  | 'paused_budget';
export type TrustLevel = 'off' | 'draft' | 'approve' | 'auto';
export interface AgentIntegrationSetting {
  enabled: boolean;
  config: Record<string, unknown>;
  /** Per-tool trust overrides; tools not listed use their default trust level. */
  tools?: Record<string, TrustLevel>;
}
export interface AgentSettings {
  maxSteps?: number;
  temperature?: number;
  language?: 'vi' | 'en';
  timezone?: string;
  /** Who may talk to the agent on messaging channels (Telegram, Zalo). */
  inbound?: { policy: 'open' | 'allowlist'; allowlist: string[] };
  /** Disclose that the user is talking to an AI on the first reply of each conversation (on by default). */
  aiDisclosure?: { enabled: boolean; text?: string };
}

export const orgProfiles = agentsSchema.table('org_profiles', {
  orgId: text('org_id').primaryKey(),
  companyName: text('company_name'),
  companyDescription: text('company_description'),
  language: text('language').notNull().default('vi'),
  timezone: text('timezone').notNull().default('Asia/Ho_Chi_Minh'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const agents = agentsSchema.table(
  'agents',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    name: text('name').notNull(),
    avatarUrl: text('avatar_url'),
    role: text('role').notNull().default('Assistant'),
    jobDescription: text('job_description').notNull().default(''),
    model: text('model').notNull().default('auto'),
    runtime: text('runtime').notNull().default('builtin'),
    plan: text('plan').notNull().default('starter'),
    integrations: jsonb('integrations')
      .$type<Record<string, AgentIntegrationSetting>>()
      .notNull()
      .default({}),
    settings: jsonb('settings').$type<AgentSettings>().notNull().default({}),
    reportsTo: text('reports_to'),
    budgetMonthlyMicros: micros('budget_monthly_micros'),
    status: text('status').$type<AgentStatus>().notNull().default('draft'),
    statusReason: text('status_reason'),
    deployedAt: ts('deployed_at'),
    lastHeartbeatAt: ts('last_heartbeat_at'),
    lastDailySummaryOn: text('last_daily_summary_on'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('agents_org_idx').on(t.orgId), index('agents_status_idx').on(t.status)],
);

export const integrationCredentials = agentsSchema.table(
  'integration_credentials',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    agentId: text('agent_id').notNull(),
    integrationId: text('integration_id').notNull(),
    /** AES-256-GCM envelope (`v1.<kid>.<iv>.<tag>.<ct>`), AAD = `org:agent:integration`. */
    ciphertext: text('ciphertext').notNull(),
    keyId: text('key_id').notNull(),
    /** Masked preview computed at write time, safe to return. */
    masked: jsonb('masked').$type<Record<string, string>>().notNull().default({}),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('integration_credentials_agent_integration_uq').on(t.agentId, t.integrationId)],
);

export const kbDocuments = agentsSchema.table(
  'kb_documents',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    /** Null = shared with every agent of the org. */
    agentId: text('agent_id'),
    title: text('title').notNull(),
    source: text('source'),
    mimeType: text('mime_type').notNull(),
    chars: integer('chars').notNull(),
    chunkCount: integer('chunk_count').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('kb_documents_org_agent_idx').on(t.orgId, t.agentId)],
);

export const kbChunks = agentsSchema.table(
  'kb_chunks',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id').notNull(),
    orgId: text('org_id').notNull(),
    agentId: text('agent_id'),
    ordinal: integer('ordinal').notNull(),
    content: text('content').notNull(),
    contentNormalized: text('content_normalized').notNull(),
    tokens: integer('tokens').notNull(),
    tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('simple'::regconfig, content)`),
    tsvNormalized: tsvector('tsv_normalized').generatedAlwaysAs(
      sql`to_tsvector('simple'::regconfig, content_normalized)`,
    ),
  },
  (t) => [
    index('kb_chunks_org_agent_idx').on(t.orgId, t.agentId),
    index('kb_chunks_document_idx').on(t.documentId),
  ],
);

export const conversations = agentsSchema.table(
  'conversations',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    agentId: text('agent_id').notNull(),
    channel: text('channel').notNull(),
    externalUserId: text('external_user_id').notNull(),
    title: text('title'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    aiDisclosedAt: ts('ai_disclosed_at'),
    lastMessageAt: ts('last_message_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('conversations_key_uq').on(t.agentId, t.channel, t.externalUserId),
    index('conversations_org_idx').on(t.orgId),
  ],
);

export const messages = agentsSchema.table(
  'messages',
  {
    id: text('id').primaryKey(),
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    conversationId: text('conversation_id').notNull(),
    agentId: text('agent_id').notNull(),
    orgId: text('org_id').notNull(),
    role: text('role').notNull(),
    content: text('content'),
    toolCalls: jsonb('tool_calls').$type<ToolCall[]>(),
    toolCallId: text('tool_call_id'),
    name: text('name'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('messages_conversation_seq_idx').on(t.conversationId, t.seq),
    index('messages_agent_created_idx').on(t.agentId, t.createdAt),
  ],
);

export const toolCalls = agentsSchema.table(
  'tool_calls',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    agentId: text('agent_id').notNull(),
    conversationId: text('conversation_id'),
    toolCallId: text('tool_call_id'),
    tool: text('tool').notNull(),
    integrationId: text('integration_id'),
    arguments: jsonb('arguments').$type<unknown>(),
    result: jsonb('result').$type<unknown>(),
    ok: boolean('ok').notNull(),
    /** `executed`, `pending_approval`, `drafted`, `denied` or `error`. */
    outcome: text('outcome').notNull(),
    error: text('error'),
    durationMs: integer('duration_ms').notNull(),
    source: text('source').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('tool_calls_agent_created_idx').on(t.agentId, t.createdAt)],
);

export type ApprovalStatus = 'pending' | 'drafted' | 'executed' | 'failed' | 'rejected';
export const approvals = agentsSchema.table(
  'approvals',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    agentId: text('agent_id').notNull(),
    conversationId: text('conversation_id'),
    toolCallId: text('tool_call_id'),
    tool: text('tool').notNull(),
    integrationId: text('integration_id').notNull(),
    arguments: jsonb('arguments').$type<unknown>().notNull(),
    /** Trust level that produced this record: `approve` (queued) or `draft` (stored only). */
    mode: text('mode').$type<'approve' | 'draft'>().notNull(),
    status: text('status').$type<ApprovalStatus>().notNull(),
    result: jsonb('result').$type<unknown>(),
    error: text('error'),
    decidedBy: text('decided_by'),
    decisionNote: text('decision_note'),
    decidedAt: ts('decided_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('approvals_org_status_idx').on(t.orgId, t.status, t.createdAt)],
);

export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export const tasks = agentsSchema.table(
  'tasks',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    assigneeAgentId: text('assignee_agent_id'),
    createdByType: text('created_by_type').$type<'user' | 'agent'>().notNull(),
    createdById: text('created_by_id'),
    status: text('status').$type<TaskStatus>().notNull().default('todo'),
    priority: text('priority').$type<TaskPriority>().notNull().default('medium'),
    dueAt: ts('due_at'),
    parentTaskId: text('parent_task_id'),
    completedAt: ts('completed_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('tasks_org_assignee_status_idx').on(t.orgId, t.assigneeAgentId, t.status),
    index('tasks_parent_idx').on(t.parentTaskId),
  ],
);

export const taskComments = agentsSchema.table(
  'task_comments',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull(),
    orgId: text('org_id').notNull(),
    authorType: text('author_type').$type<'user' | 'agent'>().notNull(),
    authorId: text('author_id'),
    body: text('body').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('task_comments_task_idx').on(t.taskId, t.createdAt)],
);

export type ReportKind = 'report' | 'daily_summary';
export const reports = agentsSchema.table(
  'reports',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    agentId: text('agent_id').notNull(),
    /** Manager agent at the time of reporting; null = the human owner. */
    managerAgentId: text('manager_agent_id'),
    kind: text('kind').$type<ReportKind>().notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    taskId: text('task_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('reports_org_created_idx').on(t.orgId, t.createdAt),
    index('reports_manager_created_idx').on(t.managerAgentId, t.createdAt),
  ],
);

export const usageMonthly = agentsSchema.table(
  'usage_monthly',
  {
    agentId: text('agent_id').notNull(),
    month: text('month').notNull(),
    orgId: text('org_id').notNull(),
    requests: integer('requests').notNull().default(0),
    promptTokens: bigint('prompt_tokens', { mode: 'number' }).notNull().default(0),
    completionTokens: bigint('completion_tokens', { mode: 'number' }).notNull().default(0),
    totalTokens: bigint('total_tokens', { mode: 'number' }).notNull().default(0),
    platformTokens: bigint('platform_tokens', { mode: 'number' }).notNull().default(0),
    customerTokens: bigint('customer_tokens', { mode: 'number' }).notNull().default(0),
    platformCostMicros: micros('platform_cost_micros').notNull().default(0),
    customerCostMicros: micros('customer_cost_micros').notNull().default(0),
    budgetWarnedAt: ts('budget_warned_at'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.month] }),
    index('usage_monthly_org_month_idx').on(t.orgId, t.month),
  ],
);

export const billingCharges = agentsSchema.table(
  'billing_charges',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    agentId: text('agent_id').notNull(),
    day: text('day').notNull(),
    plan: text('plan').notNull(),
    amountMicros: micros('amount_micros').notNull(),
    status: text('status').$type<'pending' | 'charged' | 'failed'>().notNull(),
    error: text('error'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('billing_charges_org_idx').on(t.orgId, t.createdAt)],
);

export type ChannelType = 'telegram' | 'zalo' | 'web';
export const channels = agentsSchema.table(
  'channels',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    agentId: text('agent_id').notNull(),
    type: text('type').$type<ChannelType>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    publicToken: text('public_token'),
    secretHash: text('secret_hash'),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('channels_agent_type_uq').on(t.agentId, t.type)],
);

export const runtimeTokens = agentsSchema.table(
  'runtime_tokens',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    agentId: text('agent_id').notNull(),
    kind: text('kind').$type<'container' | 'external'>().notNull(),
    label: text('label'),
    tokenHash: text('token_hash').notNull(),
    prefix: text('prefix').notNull(),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('runtime_tokens_hash_uq').on(t.tokenHash),
    index('runtime_tokens_agent_idx').on(t.agentId),
  ],
);

export const agentEvents = agentsSchema.table(
  'agent_events',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    agentId: text('agent_id').notNull(),
    level: text('level').$type<'info' | 'warn' | 'error'>().notNull(),
    type: text('type').notNull(),
    message: text('message').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('agent_events_agent_created_idx').on(t.agentId, t.createdAt)],
);

export const inboundEvents = agentsSchema.table(
  'inbound_events',
  {
    agentId: text('agent_id').notNull(),
    channel: text('channel').notNull(),
    externalId: text('external_id').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.channel, t.externalId] })],
);

export type AgentRow = typeof agents.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type ReportRow = typeof reports.$inferSelect;
export type ChannelRow = typeof channels.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
