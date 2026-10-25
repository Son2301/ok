'use client';

import { Bot, FileText, Play, RotateCw, Send, Square, Trash, Upload, Wrench } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useId, useRef, useState, useTransition } from 'react';
import { ConfirmButton, SubmitButton } from '@/components/client';
import { useI18n } from '@/components/i18n-provider';
import { Badge, Button, Field, Notice } from '@/components/ui';
import { cx } from '@/lib/cx';
import { formatMicrosVnd, formatNumber, microsToVnd } from '@/lib/format';
import { fmt } from '@/lib/i18n';
import { readSse } from '@/lib/sse';
import type {
  Agent,
  AgentStatus,
  CatalogIntegration,
  IntegrationState,
  KnowledgeDoc,
  SendResult,
  ToolSetting,
  TrustLevel,
} from '@/lib/types/agents';
import { TRUST_LEVELS } from '@/lib/types/agents';
import {
  deleteAgentAction,
  deleteKnowledgeAction,
  type FormState,
  lifecycleAction,
  setIntegrationAction,
  setToolTrustAction,
  updateAgentAction,
  uploadKnowledgeAction,
} from '../actions';

// ------------------------------------------------------------------ lifecycle

export function LifecycleBar({
  agent,
  dailyFee,
}: {
  agent: Pick<Agent, 'id' | 'name' | 'status'>;
  dailyFee: string | null;
}) {
  const { t } = useI18n();
  const A = t.agents;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (action: 'deploy' | 'start' | 'stop' | 'restart') =>
    start(async () => {
      setError(null);
      const res = await lifecycleAction(agent.id, action);
      if (!res.ok) setError(res.error ?? '');
      router.refresh();
    });
  const s: AgentStatus = agent.status;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {s === 'draft' && (
          <Button onClick={() => run('deploy')} disabled={pending}>
            <Play className="size-4" aria-hidden />
            {A.deploy}
          </Button>
        )}
        {(s === 'stopped' || s === 'suspended_billing' || s === 'paused_budget' || s === 'error') && (
          <Button onClick={() => run('start')} disabled={pending}>
            <Play className="size-4" aria-hidden />
            {A.start}
          </Button>
        )}
        {(s === 'running' || s === 'deploying') && (
          <Button variant="secondary" onClick={() => run('stop')} disabled={pending}>
            <Square className="size-4" aria-hidden />
            {A.stop}
          </Button>
        )}
        {s === 'running' && (
          <Button variant="ghost" onClick={() => run('restart')} disabled={pending}>
            <RotateCw className="size-4" aria-hidden />
            {A.restart}
          </Button>
        )}
        <ConfirmButton
          variant="ghost"
          size="md"
          title={A.delete}
          body={fmt(A.deleteConfirm, { name: agent.name })}
          confirmLabel={A.delete}
          onConfirm={async () => {
            const res = await deleteAgentAction(agent.id);
            if (res && !res.ok) setError(res.error ?? '');
          }}
        >
          <Trash className="size-4" aria-hidden />
          <span className="sr-only sm:not-sr-only">{A.delete}</span>
        </ConfirmButton>
      </div>
      {s === 'draft' && dailyFee && (
        <p className="text-xs text-muted">{fmt(A.deployNote, { amount: dailyFee })}</p>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}

// ----------------------------------------------------------------------- chat

interface ToolLine {
  id: string;
  name: string;
  outcome?: string;
  ok?: boolean;
  preview?: string;
}
interface Turn {
  role: 'user' | 'assistant';
  text: string;
  tools: ToolLine[];
  result?: SendResult;
  error?: string;
  streaming?: boolean;
}

export function AgentChat({
  agentId,
  running,
  statusLabel,
  rate,
}: {
  agentId: string;
  running: boolean;
  statusLabel: string;
  rate: number;
}) {
  const { t, locale } = useI18n();
  const A = t.agents;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputId = useId();

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the newest message whenever the transcript changes
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [turns]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const patch = (fn: (turn: Turn) => Turn) =>
    setTurns((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last) next[next.length - 1] = fn(last);
      return next;
    });

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setInput('');
    setTurns((prev) => [
      ...prev,
      { role: 'user', text: message, tools: [] },
      { role: 'assistant', text: '', tools: [], streaming: true },
    ]);
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        patch((x) => ({ ...x, error: body?.error?.message ?? `HTTP ${res.status}` }));
        return;
      }
      await readSse(
        res,
        ({ event, data }) => {
          let d: Record<string, unknown>;
          try {
            d = JSON.parse(data) as Record<string, unknown>;
          } catch {
            return;
          }
          if (event === 'delta' && typeof d.text === 'string')
            patch((x) => ({ ...x, text: x.text + d.text }));
          else if (event === 'tool_call')
            patch((x) => ({ ...x, tools: [...x.tools, { id: String(d.id), name: String(d.name) }] }));
          else if (event === 'tool_result')
            patch((x) => ({
              ...x,
              tools: x.tools.map((tl) =>
                tl.id === d.id
                  ? {
                      ...tl,
                      ok: Boolean(d.ok),
                      outcome: d.outcome as string | undefined,
                      preview: d.preview as string | undefined,
                    }
                  : tl,
              ),
            }));
          else if (event === 'done') {
            const r = d as unknown as SendResult;
            patch((x) => ({ ...x, text: r.reply || x.text, result: r }));
          } else if (event === 'error') patch((x) => ({ ...x, error: String(d.message ?? 'error') }));
        },
        ctrl.signal,
      );
    } catch (err) {
      if (!ctrl.signal.aborted)
        patch((x) => ({ ...x, error: err instanceof Error ? err.message : String(err) }));
    } finally {
      patch((x) => ({ ...x, streaming: false }));
      setBusy(false);
      abortRef.current = null;
    }
  }

  if (!running) return <Notice tone="neutral">{fmt(A.chatNotRunning, { status: statusLabel })}</Notice>;

  return (
    <div className="flex min-h-[26rem] flex-col rounded-xl border border-line bg-surface">
      <div className="flex-1 space-y-5 overflow-y-auto p-4" aria-live="polite">
        {turns.length === 0 && (
          <div className="grid min-h-60 place-items-center text-center">
            <div>
              <Bot className="mx-auto size-8 text-faint" aria-hidden />
              <p className="mx-auto mt-3 max-w-sm text-sm text-muted">{A.chatEmpty}</p>
            </div>
          </div>
        )}
        {turns.map((turn, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only transcript
          <div key={i} className={cx('flex', turn.role === 'user' ? 'justify-end' : 'justify-start')}>
            <div className="max-w-[92%] sm:max-w-[80%]">
              {turn.result?.disclosure && (
                <div className="mb-1.5 rounded-lg border border-dashed border-line px-3 py-2 text-xs text-muted">
                  <span className="font-medium">{A.disclosureLabel}:</span> {turn.result.disclosure}
                </div>
              )}
              {turn.tools.length > 0 && (
                <ul className="mb-1.5 space-y-1">
                  {turn.tools.map((tl) => (
                    <li key={tl.id} className="flex flex-wrap items-center gap-2 text-xs text-muted">
                      <Wrench className="size-3.5" aria-hidden />
                      <span>{fmt(A.toolLabel, { name: tl.name })}</span>
                      {tl.outcome && (
                        <Badge
                          tone={
                            tl.outcome === 'executed'
                              ? 'ok'
                              : tl.outcome === 'pending_approval' || tl.outcome === 'drafted'
                                ? 'warn'
                                : tl.ok === false
                                  ? 'danger'
                                  : 'neutral'
                          }
                        >
                          {(A.outcome as Record<string, string>)[tl.outcome] ?? tl.outcome}
                        </Badge>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <div
                className={cx(
                  'rounded-2xl px-4 py-2.5 text-[0.9375rem] leading-relaxed whitespace-pre-wrap break-words',
                  turn.role === 'user' ? 'bg-accent text-accent-fg' : 'bg-surface-2',
                  turn.streaming && turn.text && 'caret',
                  turn.streaming && !turn.text && 'text-muted',
                )}
              >
                {turn.text || (turn.streaming ? t.gateway.thinking : turn.error ? '' : '…')}
              </div>
              {turn.error && <p className="mt-1.5 text-sm text-danger">{turn.error}</p>}
              {turn.result && (
                <p className="mt-1.5 text-xs text-muted">
                  {fmt(A.turnReceipt, {
                    tokens: formatNumber(turn.result.usage.totalTokens, locale),
                    cost: formatMicrosVnd(turn.result.usage.costMicros, rate, locale, { precise: true }),
                    steps: turn.result.steps,
                  })}
                  {turn.result.stopReason !== 'final' && ` · ${A.stop_reason[turn.result.stopReason]}`}
                </p>
              )}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form
        className="flex items-end gap-2 border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          {A.chatPlaceholder}
        </label>
        <textarea
          id={inputId}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder={A.chatPlaceholder}
          className="input min-h-11 flex-1 resize-none text-sm"
        />
        {busy ? (
          <Button variant="secondary" onClick={() => abortRef.current?.abort()} aria-label={t.gateway.stop}>
            <Square className="size-4" aria-hidden />
          </Button>
        ) : (
          <Button type="submit" disabled={!input.trim()} aria-label={t.gateway.send}>
            <Send className="size-4" aria-hidden />
          </Button>
        )}
      </form>
    </div>
  );
}

// ------------------------------------------------------------- integrations

export function TrustControl({
  agentId,
  integrationId,
  tool,
}: {
  agentId: string;
  integrationId: string;
  tool: ToolSetting;
}) {
  const { t } = useI18n();
  const A = t.agents;
  const [value, setValue] = useState<TrustLevel>(tool.trust);
  const [pending, start] = useTransition();
  const [error, setError] = useState(false);
  const id = useId();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2.5">
      <div className="min-w-0">
        <label htmlFor={id} className="font-mono text-xs">
          {tool.name}
        </label>
        <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted">
          <span>{(A.risk as Record<string, string>)[tool.risk] ?? tool.risk}</span>
          {tool.trust !== tool.defaultTrust && (
            <span>· {fmt(A.defaultTrust, { level: A.trust[tool.defaultTrust] })}</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {error && <span className="text-xs text-danger">!</span>}
        <select
          id={id}
          value={value}
          disabled={pending}
          title={A.trustHelp[value]}
          onChange={(e) => {
            const next = e.target.value as TrustLevel;
            const prev = value;
            setValue(next);
            setError(false);
            start(async () => {
              const res = await setToolTrustAction(agentId, integrationId, tool.name, next);
              if (!res.ok) {
                setValue(prev);
                setError(true);
              }
            });
          }}
          className={cx(
            'input h-8 min-h-8 w-36 py-0 text-sm',
            value === 'auto' && 'border-ok/50',
            value === 'approve' && 'border-warn/50',
            value === 'off' && 'text-muted',
          )}
        >
          {TRUST_LEVELS.map((lvl) => (
            <option key={lvl} value={lvl}>
              {A.trust[lvl]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function IntegrationCredentials({
  agentId,
  integration,
  catalog,
}: {
  agentId: string;
  integration: IntegrationState;
  catalog?: CatalogIntegration;
}) {
  const { t } = useI18n();
  const A = t.agents;
  const [state, action] = useActionState<FormState, FormData>(setIntegrationAction, {});
  const props = catalog?.authFields?.properties ?? {};
  const fields = Object.entries(props);
  if (!fields.length) return null;
  return (
    <details className="group mt-3 rounded-lg border border-line">
      <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
        {A.credentialsTitle}
        {integration.credentials.configured && (
          <span className="ml-2 text-xs font-normal text-ok">· {A.connected}</span>
        )}
      </summary>
      <form action={action} className="space-y-3 border-t border-line p-3">
        <p className="text-xs text-muted">{A.credentialsHint}</p>
        <input type="hidden" name="agentId" value={agentId} />
        <input type="hidden" name="integrationId" value={integration.integrationId} />
        <input type="hidden" name="enabled" value="true" />
        {fields.map(([name, spec]) => {
          const masked = integration.credentials.fields[name];
          return (
            <Field
              key={name}
              label={name}
              htmlFor={`${integration.integrationId}-${name}`}
              hint={spec.description ?? (masked ? A.credentialsKeep : undefined)}
            >
              <input
                id={`${integration.integrationId}-${name}`}
                name={`cred.${name}`}
                type={/secret|token|key|password/i.test(name) ? 'password' : 'text'}
                autoComplete="off"
                placeholder={masked ?? ''}
                className="input font-mono text-sm"
              />
            </Field>
          );
        })}
        <div className="flex items-center gap-3">
          <SubmitButton size="sm" pendingLabel={t.common.saving}>
            {A.saveCredentials}
          </SubmitButton>
          {state.ok && <span className="text-sm text-ok">{state.message}</span>}
        </div>
        {state.error && <Notice tone="danger">{state.error}</Notice>}
      </form>
    </details>
  );
}

export function EnableIntegrationButton({
  agentId,
  integrationId,
  enabled,
}: {
  agentId: string;
  integrationId: string;
  enabled: boolean;
}) {
  const { t } = useI18n();
  const [state, action] = useActionState<FormState, FormData>(setIntegrationAction, {});
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="integrationId" value={integrationId} />
      <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
      <SubmitButton size="sm" variant={enabled ? 'ghost' : 'secondary'}>
        {enabled ? t.agents.disable : t.agents.enable}
      </SubmitButton>
      {state.error && <span className="text-xs text-danger">{state.error}</span>}
    </form>
  );
}

// ---------------------------------------------------------------- knowledge

export function KnowledgePanel({ agentId, docs }: { agentId: string; docs: KnowledgeDoc[] }) {
  const { t, locale } = useI18n();
  const A = t.agents;
  const [state, action] = useActionState<FormState, FormData>(uploadKnowledgeAction, {});
  const [pending, start] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const fileId = useId();
  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);
  return (
    <div className="space-y-4">
      <form ref={formRef} action={action} className="rounded-xl border border-dashed border-line-strong p-4">
        <input type="hidden" name="agentId" value={agentId} />
        <label htmlFor={fileId} className="block text-sm font-medium">
          {A.knowledgeUpload}
        </label>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <input
            id={fileId}
            name="file"
            type="file"
            required
            accept=".txt,.md,.csv,.html,.htm,text/plain,text/markdown,text/csv,text/html"
            className="text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-surface-3 file:px-3 file:py-1.5 file:text-sm file:text-fg"
          />
          <SubmitButton size="sm" pendingLabel={t.common.saving}>
            <Upload className="size-4" aria-hidden />
            {A.knowledgeUpload}
          </SubmitButton>
        </div>
        <p className="mt-2 text-xs text-muted">{A.knowledgeFormats}</p>
        {state.ok && <p className="mt-2 text-sm text-ok">{state.message}</p>}
        {state.error && <p className="mt-2 text-sm text-danger">{state.error}</p>}
      </form>
      {docs.length === 0 ? (
        <p className="text-sm text-muted">{A.knowledgeEmpty}</p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {docs.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-4 py-3">
              <FileText className="size-4 shrink-0 text-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{d.title}</div>
                <div className="text-xs text-muted">
                  {fmt(A.knowledgeMeta, { chars: formatNumber(d.chars, locale), chunks: d.chunkCount })}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                aria-label={`${t.common.remove} ${d.title}`}
                onClick={() => start(async () => void (await deleteKnowledgeAction(agentId, d.id)))}
              >
                <Trash className="size-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- settings

export function AgentSettingsForm({
  agent,
  agents,
  models,
  rate,
}: {
  agent: Agent;
  agents: { id: string; name: string }[];
  models: string[];
  rate: number;
}) {
  const { t, locale } = useI18n();
  const A = t.agents;
  const [state, action] = useActionState<FormState, FormData>(updateAgentAction, {});
  const [policy, setPolicy] = useState(agent.settings.inbound?.policy ?? 'open');
  const [budgetOn, setBudgetOn] = useState(agent.budgetMonthlyMicros !== null);
  const disclosureOn = agent.settings.aiDisclosure?.enabled ?? true;
  const modelOptions = models.includes(agent.model) ? models : [agent.model, ...models];

  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="id" value={agent.id} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={A.fieldName} htmlFor="s-name">
          <input
            id="s-name"
            name="name"
            defaultValue={agent.name}
            maxLength={80}
            required
            className="input"
          />
        </Field>
        <Field label={A.fieldRole} htmlFor="s-role">
          <input id="s-role" name="role" defaultValue={agent.role} maxLength={120} className="input" />
        </Field>
        <Field label={A.fieldJd} htmlFor="s-jd" hint={A.fieldJdHint} className="sm:col-span-2">
          <textarea
            id="s-jd"
            name="jobDescription"
            rows={8}
            defaultValue={agent.jobDescription}
            className="input text-sm leading-relaxed"
          />
        </Field>
        <Field label={A.fieldModel} htmlFor="s-model">
          <select id="s-model" name="model" defaultValue={agent.model} className="input">
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
        <Field label={A.fieldReportsTo} htmlFor="s-reports">
          <select id="s-reports" name="reportsTo" defaultValue={agent.reportsTo ?? ''} className="input">
            <option value="">{A.reportsToOwner}</option>
            {agents
              .filter((a) => a.id !== agent.id)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </Field>
      </div>

      <div className="rounded-xl border border-line p-4">
        <label className="flex cursor-pointer items-center gap-2.5 text-sm font-medium">
          <input
            type="checkbox"
            name="budget_on"
            checked={budgetOn}
            onChange={(e) => setBudgetOn(e.target.checked)}
            className="size-4 accent-[var(--accent)]"
          />
          {A.fieldBudget}
        </label>
        {budgetOn ? (
          <div className="mt-3 max-w-xs">
            <input
              name="budget"
              inputMode="decimal"
              aria-label={A.fieldBudget}
              defaultValue={formatNumber(
                Math.round(microsToVnd(agent.budgetMonthlyMicros ?? 0, rate)) || 200_000,
                locale,
              )}
              className="input"
            />
            <p className="mt-2 text-xs text-muted">{A.fieldBudgetHint}</p>
          </div>
        ) : (
          <p className="mt-2 text-sm text-warn">{A.budgetOff}</p>
        )}
      </div>

      <fieldset className="rounded-xl border border-line p-4">
        <legend className="px-1 text-sm font-medium">{A.inboundTitle}</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          {(['open', 'allowlist'] as const).map((p) => (
            <label key={p} className="flex items-center gap-2">
              <input
                type="radio"
                name="inbound"
                value={p}
                checked={policy === p}
                onChange={() => setPolicy(p)}
                className="accent-[var(--accent)]"
              />
              {p === 'open' ? A.inboundOpen : A.inboundAllowlist}
            </label>
          ))}
        </div>
        {policy === 'allowlist' && (
          <div className="mt-3">
            <textarea
              name="allowlist"
              aria-label={A.inboundAllowlist}
              rows={3}
              defaultValue={(agent.settings.inbound?.allowlist ?? []).join('\n')}
              className="input font-mono text-sm"
            />
            <p className="mt-1.5 text-xs text-muted">{A.inboundAllowlistHint}</p>
          </div>
        )}
      </fieldset>

      <fieldset className="rounded-xl border border-line p-4">
        <legend className="px-1 text-sm font-medium">{A.disclosureTitle}</legend>
        <label className="flex items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            name="disclosure"
            defaultChecked={disclosureOn}
            className="size-4 accent-[var(--accent)]"
          />
          {A.disclosureOn}
        </label>
        <p className="mt-1 text-xs text-muted">{A.disclosureLaw}</p>
        <div className="mt-3">
          <label htmlFor="s-disclosure" className="block text-sm">
            {A.disclosureText}
          </label>
          <textarea
            id="s-disclosure"
            name="disclosureText"
            rows={2}
            maxLength={500}
            defaultValue={agent.settings.aiDisclosure?.text ?? ''}
            placeholder={A.disclosureDefault}
            className="input mt-1.5 text-sm"
          />
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel={t.common.saving}>{t.common.save}</SubmitButton>
        {state.ok && (
          <span role="status" className="text-sm text-ok">
            {state.message}
          </span>
        )}
      </div>
      {state.error && <Notice tone="danger">{state.error}</Notice>}
    </form>
  );
}
