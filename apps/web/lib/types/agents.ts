/** Response shapes of the agents control plane (see apps/agents/README.md). */

export type AgentStatus =
  | 'draft'
  | 'deploying'
  | 'running'
  | 'stopped'
  | 'error'
  | 'suspended_billing'
  | 'paused_budget';

export type TrustLevel = 'off' | 'draft' | 'approve' | 'auto';
export const TRUST_LEVELS: TrustLevel[] = ['off', 'draft', 'approve', 'auto'];

export interface AgentIntegrationSetting {
  enabled: boolean;
  config: Record<string, unknown>;
  tools?: Record<string, TrustLevel>;
}

export interface AgentSettings {
  maxSteps?: number;
  temperature?: number;
  language?: 'vi' | 'en';
  timezone?: string;
  inbound?: { policy: 'open' | 'allowlist'; allowlist: string[] };
  aiDisclosure?: { enabled: boolean; text?: string };
}

export interface Agent {
  id: string;
  orgId: string;
  name: string;
  avatarUrl: string | null;
  role: string;
  jobDescription: string;
  model: string;
  runtime: 'builtin' | 'openclaw' | 'hermes' | string;
  plan: 'starter' | 'pro' | string;
  integrations: Record<string, AgentIntegrationSetting>;
  settings: AgentSettings;
  reportsTo: string | null;
  budgetMonthlyMicros: number | null;
  status: AgentStatus;
  statusReason: string | null;
  deployedAt: string | null;
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ToolSetting {
  name: string;
  risk: string;
  defaultTrust: TrustLevel;
  trust: TrustLevel;
}

export interface IntegrationState {
  integrationId: string;
  name: string;
  category: string;
  verified: boolean;
  status: 'available' | 'coming_soon' | string;
  enabled: boolean;
  ready: boolean;
  config: Record<string, unknown>;
  tools: ToolSetting[];
  credentials: { configured: boolean; fields: Record<string, string>; updatedAt: string | null };
}

export interface AgentChannel {
  id: string;
  type: 'telegram' | 'zalo' | 'web';
  enabled: boolean;
  config: Record<string, unknown>;
  webhookUrl?: string;
  publicToken?: string;
  chatUrl?: string;
  embed?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentDetail extends Agent {
  integrationStatus: IntegrationState[];
  channels: AgentChannel[];
  usage: {
    month: string;
    totalTokens: number;
    platformTokens: number;
    customerTokens: number;
    customerCostMicros: number;
  } | null;
}

export interface AgentStatusView {
  id: string;
  status: AgentStatus;
  statusReason: string | null;
  driver: string;
  runtime: { state: string; detail?: string } & Record<string, unknown>;
  usage: {
    month: string;
    totalTokens: number;
    includedTokens: number;
    platformTokens: number;
    customerTokens: number;
    customerCostMicros: number;
    budgetMonthlyMicros: number | null;
  };
  logs: unknown[];
  events: { at: string; level: string; type: string; message: string; data: unknown }[];
}

export interface JsonSchemaObject {
  type?: string;
  properties?: Record<
    string,
    { type?: string; description?: string; enum?: string[]; default?: unknown; items?: unknown }
  >;
  required?: string[];
}

export interface CatalogIntegration {
  id: string;
  name: string;
  category: string;
  description: string;
  verified: boolean;
  status: 'available' | 'coming_soon' | string;
  docsUrl: string | null;
  alwaysEnabled: boolean;
  channel: string | null;
  requiresCredentials: boolean;
  authFields: JsonSchemaObject;
  configFields: JsonSchemaObject | null;
  tools: { name: string; description: string; risk: string; defaultTrust: TrustLevel; parameters: unknown }[];
}

export type ApprovalStatus = 'pending' | 'drafted' | 'executed' | 'failed' | 'rejected';

export interface Approval {
  id: string;
  agentId: string;
  conversationId: string | null;
  tool: string;
  integrationId: string;
  arguments: unknown;
  mode: 'approve' | 'draft';
  status: ApprovalStatus;
  result: unknown;
  error: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface Task {
  id: string;
  title: string;
  description: string;
  assigneeAgentId: string | null;
  createdBy: { type: 'user' | 'agent'; id: string | null };
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: string | null;
  parentTaskId: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Report {
  id: string;
  agentId: string;
  managerAgentId: string | null;
  kind: 'report' | 'daily_summary';
  title: string;
  body: string;
  taskId: string | null;
  createdAt: string;
}

export interface KnowledgeDoc {
  id: string;
  orgId?: string;
  agentId: string | null;
  title: string;
  source: string | null;
  mimeType: string;
  chars: number;
  chunkCount: number;
  createdAt?: string;
}

export interface Plan {
  id: string;
  name: string;
  monthlyPriceMicros: number;
  dailyPriceMicros: number;
  includedTokensPerMonth: number;
  limits: { cpus: number; memoryMb: number };
}

export interface AgentUsageRow {
  agentId: string;
  name: string;
  plan: string;
  includedTokens: number;
  requests: number;
  totalTokens: number;
  platformTokens: number;
  customerTokens: number;
  customerCostMicros: number;
  remainingIncludedTokens: number;
  budgetMonthlyMicros: number | null;
}

export interface Conversation {
  id: string;
  channel: string;
  externalUserId: string;
  metadata: unknown;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface ConversationMessage {
  id: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string | null;
  toolCalls: unknown;
  toolCallId: string | null;
  name: string | null;
  createdAt: string;
}

export interface ToolTrace {
  id: string;
  name: string;
  arguments: unknown;
  ok: boolean;
  outcome?: string;
  error?: string;
  preview: string;
  durationMs: number;
}

export interface SendResult {
  conversationId: string;
  messageId: string;
  reply: string;
  disclosure: string | null;
  toolCalls: ToolTrace[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number; costMicros: number };
  steps: number;
  stopReason: 'final' | 'max_steps' | 'token_budget' | 'time_budget';
}

export interface AgentInput {
  name?: string;
  role?: string;
  jobDescription?: string;
  model?: string;
  plan?: string;
  budgetMonthlyMicros?: number | null;
  reportsTo?: string | null;
  settings?: AgentSettings;
  integrations?: Record<string, Partial<AgentIntegrationSetting>>;
}
