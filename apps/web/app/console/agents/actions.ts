'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { env } from '@/lib/env';
import { parseVndInput, vndToMicros } from '@/lib/format';
import { getI18n } from '@/lib/i18n/server';
import { agentsApi, gatewayApi } from '@/lib/services';
import { requireSession } from '@/lib/session';
import {
  type AgentSettings,
  type TaskPriority,
  type TaskStatus,
  TRUST_LEVELS,
  type TrustLevel,
} from '@/lib/types/agents';

export interface FormState {
  ok?: boolean;
  error?: string;
  message?: string;
}

async function rate(orgId: string) {
  const res = await gatewayApi.wallet(orgId);
  return res.ok ? res.data.vndPerUsd : env().vndPerUsd;
}

const str = (form: FormData, key: string, max = 20_000) =>
  String(form.get(key) ?? '')
    .trim()
    .slice(0, max);

export async function createAgentAction(_prev: FormState, form: FormData): Promise<FormState> {
  const session = await requireSession();
  const { t } = await getI18n();
  const name = str(form, 'name', 80);
  if (!name) return { error: t.agents.fieldName };
  let budgetMonthlyMicros: number | null = null;
  if (form.get('budget_on') === 'on') {
    const vnd = parseVndInput(str(form, 'budget', 40));
    if (vnd === null || vnd < 0) return { error: t.keys.capInvalid };
    budgetMonthlyMicros = vndToMicros(vnd, await rate(session.org.id));
  }
  const reportsTo = str(form, 'reportsTo', 100) || null;
  const res = await agentsApi.create(session.org.id, {
    name,
    role: str(form, 'role', 120) || undefined,
    jobDescription: str(form, 'jobDescription') || undefined,
    model: str(form, 'model', 120) || 'auto',
    plan: str(form, 'plan', 20) || 'starter',
    budgetMonthlyMicros,
    reportsTo,
    settings: { language: form.get('language') === 'en' ? 'en' : 'vi', aiDisclosure: { enabled: true } },
  });
  if (!res.ok) return { error: res.error.message };
  revalidatePath('/console/agents');
  redirect(`/console/agents/${encodeURIComponent(res.data.id)}`);
}

export async function lifecycleAction(
  agentId: string,
  action: 'deploy' | 'start' | 'stop' | 'restart',
): Promise<{ ok: boolean; error?: string }> {
  const session = await requireSession();
  const res = await agentsApi.lifecycle(session.org.id, agentId, action);
  revalidatePath(`/console/agents/${agentId}`);
  revalidatePath('/console/agents');
  return res.ok ? { ok: true } : { ok: false, error: res.error.message };
}

export async function deleteAgentAction(agentId: string): Promise<{ ok: boolean; error?: string }> {
  const session = await requireSession();
  const res = await agentsApi.remove(session.org.id, agentId);
  if (!res.ok) return { ok: false, error: res.error.message };
  revalidatePath('/console/agents');
  redirect('/console/agents');
}

export async function updateAgentAction(_prev: FormState, form: FormData): Promise<FormState> {
  const session = await requireSession();
  const { t } = await getI18n();
  const id = str(form, 'id', 100);
  const settings: AgentSettings = {
    inbound: {
      policy: form.get('inbound') === 'allowlist' ? 'allowlist' : 'open',
      allowlist: str(form, 'allowlist', 50_000)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 1000),
    },
    aiDisclosure: {
      enabled: form.get('disclosure') === 'on',
      ...(str(form, 'disclosureText', 500) ? { text: str(form, 'disclosureText', 500) } : {}),
    },
  };
  let budgetMonthlyMicros: number | null = null;
  if (form.get('budget_on') === 'on') {
    const vnd = parseVndInput(str(form, 'budget', 40));
    if (vnd === null || vnd < 0) return { error: t.keys.capInvalid };
    budgetMonthlyMicros = vndToMicros(vnd, await rate(session.org.id));
  }
  const res = await agentsApi.update(session.org.id, id, {
    name: str(form, 'name', 80) || undefined,
    role: str(form, 'role', 120) || undefined,
    jobDescription: str(form, 'jobDescription'),
    model: str(form, 'model', 120) || undefined,
    budgetMonthlyMicros,
    reportsTo: str(form, 'reportsTo', 100) || null,
    settings,
  });
  if (!res.ok) return { error: res.error.message };
  revalidatePath(`/console/agents/${id}`);
  return { ok: true, message: res.data.requiresRedeploy ? t.agents.redeployNeeded : t.common.saved };
}

export async function setToolTrustAction(
  agentId: string,
  integrationId: string,
  tool: string,
  trust: TrustLevel,
): Promise<{ ok: boolean; error?: string }> {
  const session = await requireSession();
  if (!TRUST_LEVELS.includes(trust)) return { ok: false, error: 'invalid trust level' };
  const res = await agentsApi.setIntegration(session.org.id, agentId, integrationId, {
    tools: { [tool]: trust },
  });
  revalidatePath(`/console/agents/${agentId}`);
  return res.ok ? { ok: true } : { ok: false, error: res.error.message };
}

export async function setIntegrationAction(_prev: FormState, form: FormData): Promise<FormState> {
  const session = await requireSession();
  const { t } = await getI18n();
  const agentId = str(form, 'agentId', 100);
  const integrationId = str(form, 'integrationId', 100);
  const enabled = form.get('enabled');
  const credentials: Record<string, unknown> = {};
  for (const [k, v] of form.entries()) {
    if (k.startsWith('cred.') && typeof v === 'string' && v.trim()) credentials[k.slice(5)] = v.trim();
  }
  const res = await agentsApi.setIntegration(session.org.id, agentId, integrationId, {
    ...(enabled === 'true' || enabled === 'false' ? { enabled: enabled === 'true' } : {}),
    ...(Object.keys(credentials).length ? { credentials } : {}),
  });
  if (!res.ok) return { error: res.error.message };
  revalidatePath(`/console/agents/${agentId}`);
  return { ok: true, message: t.common.saved };
}

export async function decideApprovalAction(
  approvalId: string,
  decision: 'approve' | 'reject',
  note?: string,
): Promise<{ ok: boolean; error?: string; status?: string }> {
  const session = await requireSession();
  const res = await agentsApi.decide(session.org.id, approvalId, decision, note?.slice(0, 1000) || undefined);
  revalidatePath('/console/agents', 'layout');
  return res.ok ? { ok: true, status: res.data.status } : { ok: false, error: res.error.message };
}

export async function createTaskAction(_prev: FormState, form: FormData): Promise<FormState> {
  const session = await requireSession();
  const title = str(form, 'title', 200);
  if (!title) return { error: (await getI18n()).t.agents.taskTitle };
  const priority = str(form, 'priority', 10) as TaskPriority;
  const res = await agentsApi.createTask(session.org.id, {
    title,
    description: str(form, 'description', 10_000) || undefined,
    assigneeAgentId: str(form, 'assignee', 100) || null,
    priority: ['low', 'medium', 'high', 'urgent'].includes(priority) ? priority : 'medium',
  });
  if (!res.ok) return { error: res.error.message };
  revalidatePath('/console/agents/tasks');
  return { ok: true };
}

export async function moveTaskAction(taskId: string, status: TaskStatus): Promise<{ ok: boolean }> {
  const session = await requireSession();
  if (!['todo', 'in_progress', 'blocked', 'done'].includes(status)) return { ok: false };
  const res = await agentsApi.updateTask(session.org.id, taskId, { status });
  revalidatePath('/console/agents/tasks');
  return { ok: res.ok };
}

export async function uploadKnowledgeAction(_prev: FormState, form: FormData): Promise<FormState> {
  const session = await requireSession();
  const { t } = await getI18n();
  const agentId = str(form, 'agentId', 100);
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) return { error: t.agents.knowledgeFormats };
  if (file.size > 5 * 1024 * 1024) return { error: t.agents.knowledgeFormats };
  const out = new FormData();
  out.set('file', file, file.name);
  const res = await agentsApi.addKnowledge(session.org.id, agentId, out);
  if (!res.ok) return { error: res.error.message };
  revalidatePath(`/console/agents/${agentId}`);
  return { ok: true, message: t.agents.knowledgeUploaded.replace('{title}', res.data.title) };
}

export async function deleteKnowledgeAction(agentId: string, docId: string): Promise<{ ok: boolean }> {
  const session = await requireSession();
  const res = await agentsApi.deleteKnowledge(session.org.id, agentId, docId);
  revalidatePath(`/console/agents/${agentId}`);
  return { ok: res.ok };
}
