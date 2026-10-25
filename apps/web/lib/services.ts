import 'server-only';
import { env, warnOnDevToken } from './env';
import {
  type CallOptions,
  createServiceClient,
  type Query,
  type Result,
  type ServiceClient,
} from './service-client';
import type {
  Agent,
  AgentChannel,
  AgentDetail,
  AgentInput,
  AgentStatusView,
  AgentUsageRow,
  Approval,
  CatalogIntegration,
  Conversation,
  ConversationMessage,
  IntegrationState,
  KnowledgeDoc,
  Plan,
  Report,
  Task,
  TaskPriority,
  TaskStatus,
  TrustLevel,
} from './types/agents';
import type {
  GwGeneration,
  GwHealth,
  GwModelList,
  GwProvidersHealth,
  GwRequestList,
  GwUsage,
  Topup,
  WalletSummary,
} from './types/gateway';
import type {
  InstallUrl,
  RepoSettingsOverride,
  RepoSettingsResponse,
  ReviewDetail,
  ReviewHealth,
  ReviewInstallation,
  ReviewRepo,
  ReviewSummary,
  ReviewUsage,
} from './types/review';
import type { CheckHistoryRow, CheckKind, Localized, SafePricing, SafeStats, Verdict } from './types/safe';

export type { Result, ServiceErrorInfo } from './service-client';
export { ServiceError } from './service-client';

/** Server-only client bound to this process's environment. The internal token never leaves the server. */
export function services(): ServiceClient {
  warnOnDevToken();
  const cfg = env();
  return createServiceClient({
    bases: cfg.services,
    internalToken: cfg.internalToken,
    timeoutMs: cfg.serviceTimeoutMs,
  });
}

// ----------------------------------------------------------------- gateway

export const gatewayApi = {
  health: (): Promise<Result<GwHealth>> =>
    services().attempt('gateway', '/health', { auth: false, timeoutMs: 3000 }),
  /** Public catalog. */
  models: (query: Query = {}): Promise<Result<GwModelList>> =>
    services().attempt('gateway', '/v1/models', { auth: false, query }),
  usage: (
    orgId: string,
    query: { from?: string; to?: string; group_by?: string },
  ): Promise<Result<GwUsage>> => services().attempt('gateway', '/v1/usage', { orgId, query }),
  requests: (
    orgId: string,
    query: { limit?: number; cursor?: string; status?: string; model?: string },
  ): Promise<Result<GwRequestList>> => services().attempt('gateway', '/v1/requests', { orgId, query }),
  generation: (orgId: string, id: string): Promise<Result<{ data: GwGeneration }>> =>
    services().attempt('gateway', `/v1/generation/${encodeURIComponent(id)}`, { orgId }),
  providersHealth: (orgId: string): Promise<Result<GwProvidersHealth>> =>
    services().attempt('gateway', '/v1/providers/health', { orgId }),

  // Platform wallet routes, served by the gateway host.
  wallet: (orgId: string): Promise<Result<WalletSummary>> =>
    services().attempt('gateway', '/v1/wallet', { orgId }),
  topups: (orgId: string): Promise<Result<{ data: Topup[] }>> =>
    services().attempt('gateway', '/v1/wallet/topups', { orgId }),
  topup: (orgId: string, id: string): Promise<Result<Topup>> =>
    services().attempt('gateway', `/v1/wallet/topups/${encodeURIComponent(id)}`, { orgId }),
  createTopup: (orgId: string, amountVnd: number): Promise<Result<Topup>> =>
    services().attempt('gateway', '/v1/wallet/topups', { orgId, method: 'POST', body: { amountVnd } }),
};

// ------------------------------------------------------------------ review

export const reviewApi = {
  health: (): Promise<Result<ReviewHealth>> =>
    services().attempt('review', '/health', { auth: false, timeoutMs: 3000 }),
  installations: (orgId: string): Promise<Result<{ installations: ReviewInstallation[] }>> =>
    services().attempt('review', '/v1/installations', { orgId }),
  installUrl: (orgId: string): Promise<Result<InstallUrl>> =>
    services().attempt('review', '/v1/installations/install-url', { orgId }),
  link: (orgId: string, body: { installationId: number; state: string; code?: string }) =>
    services().attempt<{ installation: { id: number; account: string; status: string; linkedAt: string } }>(
      'review',
      '/v1/installations/link',
      { orgId, method: 'POST', body },
    ),
  unlink: (orgId: string, id: number) =>
    services().attempt<{ ok: boolean }>('review', `/v1/installations/${id}`, { orgId, method: 'DELETE' }),
  repos: (orgId: string): Promise<Result<{ repos: ReviewRepo[] }>> =>
    services().attempt('review', '/v1/repos', { orgId }),
  repoSettings: (orgId: string, fullName: string): Promise<Result<RepoSettingsResponse>> =>
    services().attempt('review', `/v1/repos/${repoPath(fullName)}/settings`, { orgId }),
  saveRepoSettings: (orgId: string, fullName: string, settings: RepoSettingsOverride) =>
    services().attempt<{ repo: string; settings: RepoSettingsOverride }>(
      'review',
      `/v1/repos/${repoPath(fullName)}/settings`,
      { orgId, method: 'PUT', body: settings },
    ),
  reviews: (
    orgId: string,
    query: { repo?: string; pr?: number; status?: string; limit?: number; before?: string } = {},
  ): Promise<Result<{ reviews: ReviewSummary[] }>> =>
    services().attempt('review', '/v1/reviews', { orgId, query }),
  review: (orgId: string, id: string): Promise<Result<ReviewDetail>> =>
    services().attempt('review', `/v1/reviews/${encodeURIComponent(id)}`, { orgId }),
  run: (orgId: string, target: string, full: boolean) =>
    services().attempt<{ queued: unknown; key: string; repo: string; number: number; mode: string }>(
      'review',
      '/v1/reviews/run',
      { orgId, method: 'POST', body: { target, full } },
    ),
  usage: (orgId: string): Promise<Result<ReviewUsage>> =>
    services().attempt('review', '/v1/usage', { orgId }),
};

// ------------------------------------------------------------------ agents

export const agentsApi = {
  health: () =>
    services().attempt<{ status?: string }>('agents', '/health', { auth: false, timeoutMs: 3000 }),
  list: (orgId: string): Promise<Result<{ data: Agent[] }>> =>
    services().attempt('agents', '/v1/agents', { orgId }),
  get: (orgId: string, id: string): Promise<Result<AgentDetail>> =>
    services().attempt('agents', `/v1/agents/${enc(id)}`, { orgId }),
  create: (orgId: string, body: AgentInput): Promise<Result<Agent>> =>
    services().attempt('agents', '/v1/agents', { orgId, method: 'POST', body }),
  update: (
    orgId: string,
    id: string,
    body: AgentInput,
  ): Promise<Result<Agent & { requiresRedeploy: boolean }>> =>
    services().attempt('agents', `/v1/agents/${enc(id)}`, { orgId, method: 'PATCH', body }),
  remove: (orgId: string, id: string) =>
    services().attempt<void>('agents', `/v1/agents/${enc(id)}`, { orgId, method: 'DELETE' }),
  lifecycle: (orgId: string, id: string, action: 'deploy' | 'start' | 'stop' | 'restart') =>
    services().attempt<{ agent: Agent; runtime: unknown }>('agents', `/v1/agents/${enc(id)}/${action}`, {
      orgId,
      method: 'POST',
      timeoutMs: 60_000,
    }),
  status: (orgId: string, id: string): Promise<Result<AgentStatusView>> =>
    services().attempt('agents', `/v1/agents/${enc(id)}/status`, { orgId, query: { tail: 50 } }),
  conversations: (orgId: string, id: string): Promise<Result<{ data: Conversation[] }>> =>
    services().attempt('agents', `/v1/agents/${enc(id)}/conversations`, { orgId, query: { limit: 30 } }),
  messages: (orgId: string, id: string, cid: string) =>
    services().attempt<{
      conversation: { id: string; channel: string; externalUserId: string };
      data: ConversationMessage[];
    }>('agents', `/v1/agents/${enc(id)}/conversations/${enc(cid)}/messages`, {
      orgId,
      query: { limit: 100 },
    }),
  catalog: (orgId: string): Promise<Result<{ data: CatalogIntegration[] }>> =>
    services().attempt('agents', '/v1/integrations', { orgId }),
  integrations: (orgId: string, id: string): Promise<Result<{ data: IntegrationState[] }>> =>
    services().attempt('agents', `/v1/agents/${enc(id)}/integrations`, { orgId }),
  setIntegration: (
    orgId: string,
    id: string,
    integrationId: string,
    body: {
      enabled?: boolean;
      config?: Record<string, unknown>;
      credentials?: Record<string, unknown>;
      tools?: Record<string, TrustLevel>;
    },
  ): Promise<Result<IntegrationState>> =>
    services().attempt('agents', `/v1/agents/${enc(id)}/integrations/${enc(integrationId)}`, {
      orgId,
      method: 'PUT',
      body,
    }),
  removeIntegration: (orgId: string, id: string, integrationId: string) =>
    services().attempt<void>('agents', `/v1/agents/${enc(id)}/integrations/${enc(integrationId)}`, {
      orgId,
      method: 'DELETE',
    }),
  approvals: (
    orgId: string,
    query: { status?: string; agentId?: string; limit?: number } = {},
  ): Promise<Result<{ data: Approval[] }>> => services().attempt('agents', '/v1/approvals', { orgId, query }),
  decide: (
    orgId: string,
    approvalId: string,
    decision: 'approve' | 'reject',
    note?: string,
  ): Promise<Result<Approval>> =>
    services().attempt('agents', `/v1/approvals/${enc(approvalId)}/${decision}`, {
      orgId,
      method: 'POST',
      body: note ? { note } : {},
      timeoutMs: 60_000,
    }),
  tasks: (
    orgId: string,
    query: { assigneeAgentId?: string; status?: string; limit?: number } = {},
  ): Promise<Result<{ data: Task[] }>> => services().attempt('agents', '/v1/tasks', { orgId, query }),
  createTask: (
    orgId: string,
    body: {
      title: string;
      description?: string;
      assigneeAgentId?: string | null;
      priority?: TaskPriority;
      status?: TaskStatus;
    },
  ): Promise<Result<Task>> => services().attempt('agents', '/v1/tasks', { orgId, method: 'POST', body }),
  updateTask: (
    orgId: string,
    taskId: string,
    body: Partial<Pick<Task, 'status' | 'priority' | 'title'>>,
  ): Promise<Result<Task>> =>
    services().attempt('agents', `/v1/tasks/${enc(taskId)}`, { orgId, method: 'PATCH', body }),
  reports: (
    orgId: string,
    query: { agentId?: string; kind?: string; limit?: number } = {},
  ): Promise<Result<{ data: Report[] }>> => services().attempt('agents', '/v1/reports', { orgId, query }),
  knowledge: (orgId: string, id: string): Promise<Result<{ data: KnowledgeDoc[] }>> =>
    services().attempt('agents', `/v1/agents/${enc(id)}/knowledge`, { orgId }),
  addKnowledge: (orgId: string, id: string, form: FormData): Promise<Result<KnowledgeDoc>> =>
    services().attempt('agents', `/v1/agents/${enc(id)}/knowledge`, {
      orgId,
      method: 'POST',
      form,
      timeoutMs: 60_000,
    }),
  deleteKnowledge: (orgId: string, id: string, docId: string) =>
    services().attempt<void>('agents', `/v1/agents/${enc(id)}/knowledge/${enc(docId)}`, {
      orgId,
      method: 'DELETE',
    }),
  plans: (orgId: string): Promise<Result<{ data: Plan[] }>> =>
    services().attempt('agents', '/v1/plans', { orgId }),
  usage: (orgId: string, month?: string): Promise<Result<{ month: string; data: AgentUsageRow[] }>> =>
    services().attempt('agents', '/v1/usage', { orgId, query: { month } }),
  channels: (orgId: string, id: string): Promise<Result<{ data: AgentChannel[] }>> =>
    services().attempt('agents', `/v1/agents/${enc(id)}/channels`, { orgId }),
};

// -------------------------------------------------------------------- safe

/**
 * Who a Safe check runs as: a signed-in org (internal token, per-org quota,
 * history kept) or an anonymous visitor (per-IP free tier; the visitor's IP
 * is forwarded so the quota applies to them, not to the web server).
 */
export type SafeCaller =
  | { orgId: string; userId?: string }
  | { anonymous: true; forwardedFor?: string | null };

function safeOpts(caller: SafeCaller): CallOptions {
  const headers: Record<string, string> = {};
  if ('orgId' in caller) {
    if (caller.userId) headers['x-user-id'] = caller.userId;
    return { orgId: caller.orgId, headers };
  }
  if (caller.forwardedFor) headers['x-forwarded-for'] = caller.forwardedFor;
  return { auth: false, headers };
}

const SAFE_PATH: Record<string, string> = {
  url: '/v1/check/url',
  text: '/v1/check/text',
  phone: '/v1/check/phone',
  bank_account: '/v1/check/bank-account',
  email: '/v1/check/email',
  ai_text: '/v1/check/ai-text',
  image: '/v1/check/image',
  video: '/v1/check/video',
  audio: '/v1/check/audio',
};

export const safeApi = {
  check: (caller: SafeCaller, kind: CheckKind, body: Record<string, unknown>): Promise<Result<Verdict>> =>
    services().attempt('safe', SAFE_PATH[kind]!, {
      ...safeOpts(caller),
      method: 'POST',
      body,
      timeoutMs: 45_000,
    }),
  checkMedia: (
    caller: SafeCaller,
    kind: 'image' | 'video' | 'audio',
    form: FormData,
  ): Promise<Result<Verdict>> =>
    services().attempt('safe', SAFE_PATH[kind]!, {
      ...safeOpts(caller),
      method: 'POST',
      form,
      timeoutMs: 60_000,
    }),
  report: (caller: SafeCaller, body: Record<string, unknown>) =>
    services().attempt<{ id: string; status: string; deduplicated: boolean; message: Localized }>(
      'safe',
      '/v1/reports',
      {
        ...safeOpts(caller),
        method: 'POST',
        body,
      },
    ),
  stats: (days = 7): Promise<Result<SafeStats>> =>
    services().attempt('safe', '/v1/reports/stats', { auth: false, query: { days }, timeoutMs: 5000 }),
  history: (orgId: string, query: { limit?: number; before?: string; kind?: string } = {}) =>
    services().attempt<{ data: CheckHistoryRow[]; nextBefore: string | null }>('safe', '/v1/checks', {
      orgId,
      query,
    }),
  historyItem: (orgId: string, id: string): Promise<Result<Verdict>> =>
    services().attempt('safe', `/v1/checks/${enc(id)}`, { orgId }),
  pricing: (): Promise<Result<SafePricing>> =>
    services().attempt('safe', '/v1/pricing', { auth: false, timeoutMs: 5000 }),
};

const enc = encodeURIComponent;

function repoPath(fullName: string): string {
  const [owner = '', name = ''] = fullName.split('/');
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}
