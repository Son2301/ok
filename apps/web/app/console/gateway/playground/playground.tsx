'use client';

import { ExternalLink, MessageSquare, RefreshCw, Send, Square } from 'lucide-react';
import Link from 'next/link';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '@/components/i18n-provider';
import { Button, Notice } from '@/components/ui';
import { cx } from '@/lib/cx';
import { formatMicrosVnd, formatNumber } from '@/lib/format';
import { fmt } from '@/lib/i18n';
import { readSse } from '@/lib/sse';

export interface ModelOption {
  id: string;
  name: string;
  group: 'auto' | 'model';
}

interface Meta {
  genId?: string;
  model?: string;
  provider?: string;
  costMicros?: number;
  promptTokens?: number;
  completionTokens?: number;
  estimated?: boolean;
  reason?: string;
}

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  meta?: Meta;
  error?: string;
  streaming?: boolean;
}

interface Chunk {
  id?: string;
  model?: string;
  provider?: string;
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens: number; completion_tokens: number; cost_micros?: number; estimated?: boolean };
  routing?: { reason?: string };
  error?: { message?: string };
}

export function Playground({ models, rate }: { models: ModelOption[]; rate: number }) {
  const { t, locale } = useI18n();
  const G = t.gateway;
  const [model, setModel] = useState('auto');
  const [system, setSystem] = useState('');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ tone: 'warn' | 'danger'; text: string; billing?: boolean } | null>(
    null,
  );
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const ids = { model: useId(), system: useId(), input: useId() };

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the newest message whenever the transcript changes
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const total = messages.reduce((s, m) => s + (m.meta?.costMicros ?? 0), 0);

  const patchLast = (fn: (m: Msg) => Msg) =>
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last) next[next.length - 1] = fn(last);
      return next;
    });

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setBanner(null);
    const history = [...messages.filter((m) => !m.error), { role: 'user' as const, content: text }];
    setMessages([
      ...messages,
      { role: 'user', content: text },
      { role: 'assistant', content: '', streaming: true },
    ]);
    setInput('');
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch('/api/gateway/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            ...(system.trim() ? [{ role: 'system', content: system.trim() }] : []),
            ...history.map((m) => ({ role: m.role, content: m.content })),
          ],
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        const code = body?.error?.code;
        const message = body?.error?.message ?? `HTTP ${res.status}`;
        if (res.status === 402 || code === 'payment_required')
          setBanner({ tone: 'warn', text: G.noBalance, billing: true });
        patchLast((m) => ({ ...m, streaming: false, error: fmt(G.streamError, { message }) }));
        return;
      }
      const meta: Meta = {};
      await readSse(
        res,
        ({ data }) => {
          if (data === '[DONE]') return;
          let chunk: Chunk;
          try {
            chunk = JSON.parse(data) as Chunk;
          } catch {
            return;
          }
          if (chunk.id) meta.genId = chunk.id;
          if (chunk.model) meta.model = chunk.model;
          if (chunk.provider) meta.provider = chunk.provider;
          if (chunk.routing?.reason) meta.reason = chunk.routing.reason;
          if (chunk.usage) {
            meta.promptTokens = chunk.usage.prompt_tokens;
            meta.completionTokens = chunk.usage.completion_tokens;
            meta.costMicros = chunk.usage.cost_micros;
            meta.estimated = chunk.usage.estimated;
          }
          const delta = chunk.choices?.[0]?.delta?.content ?? '';
          const err = chunk.error?.message;
          patchLast((m) => ({
            ...m,
            content: m.content + delta,
            meta: { ...meta },
            ...(err ? { error: fmt(G.streamError, { message: err }) } : {}),
          }));
        },
        ctrl.signal,
      );
    } catch (err) {
      if (!ctrl.signal.aborted) {
        patchLast((m) => ({
          ...m,
          error: fmt(G.streamError, { message: err instanceof Error ? err.message : String(err) }),
        }));
      }
    } finally {
      patchLast((m) => ({ ...m, streaming: false }));
      setBusy(false);
      abortRef.current = null;
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[17rem_1fr]">
      <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
        <div className="rounded-xl border border-line bg-surface p-4 shadow-card">
          <label htmlFor={ids.model} className="block text-sm font-medium">
            {G.model}
          </label>
          <select
            id={ids.model}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="input mt-1.5"
            disabled={busy}
          >
            <optgroup label="Auto">
              {models
                .filter((m) => m.group === 'auto')
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id === 'auto' ? G.autoLabel : m.id}
                  </option>
                ))}
            </optgroup>
            <optgroup label={t.models.colModel}>
              {models
                .filter((m) => m.group === 'model')
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
            </optgroup>
          </select>
          <label htmlFor={ids.system} className="mt-4 block text-sm font-medium">
            {G.systemPrompt}
          </label>
          <textarea
            id={ids.system}
            value={system}
            onChange={(e) => setSystem(e.target.value)}
            placeholder={G.systemPlaceholder}
            rows={4}
            className="input mt-1.5 min-h-24 text-sm"
          />
        </div>
        {messages.length > 0 && (
          <div className="rounded-xl border border-line bg-surface p-4 text-sm shadow-card">
            <div className="text-muted">
              {fmt(G.totalCost, { cost: formatMicrosVnd(total, rate, locale, { precise: true }) })}
            </div>
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              onClick={() => {
                abortRef.current?.abort();
                setMessages([]);
                setBanner(null);
              }}
            >
              <RefreshCw className="size-4" aria-hidden />
              {G.clear}
            </Button>
          </div>
        )}
      </aside>

      <section
        className="flex min-h-[28rem] flex-col rounded-xl border border-line bg-surface shadow-card"
        aria-label={G.playgroundTitle}
      >
        <div className="flex-1 space-y-5 overflow-y-auto p-4 sm:p-5" aria-live="polite">
          {messages.length === 0 && (
            <div className="grid h-full min-h-64 place-items-center text-center">
              <div>
                <MessageSquare className="mx-auto size-8 text-faint" aria-hidden />
                <p className="mx-auto mt-3 max-w-sm text-sm text-muted">{G.playgroundEmpty}</p>
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only transcript
            <MessageView key={i} m={m} rate={rate} />
          ))}
          <div ref={endRef} />
        </div>
        {banner && (
          <div className="px-4 sm:px-5">
            <Notice
              tone={banner.tone}
              action={
                banner.billing ? (
                  <Link href="/console/billing#topup" className="font-medium underline">
                    {t.console.topUp}
                  </Link>
                ) : undefined
              }
            >
              {banner.text}
            </Notice>
          </div>
        )}
        <form
          className="flex items-end gap-2 border-t border-line p-3 sm:p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label htmlFor={ids.input} className="sr-only">
            {G.messagePlaceholder}
          </label>
          <textarea
            id={ids.input}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={G.messagePlaceholder}
            rows={2}
            className="input max-h-48 min-h-11 flex-1 resize-none text-sm"
          />
          {busy ? (
            <Button variant="secondary" onClick={() => abortRef.current?.abort()} aria-label={G.stop}>
              <Square className="size-4" aria-hidden />
              <span className="hidden sm:inline">{G.stop}</span>
            </Button>
          ) : (
            <Button type="submit" disabled={!input.trim()} aria-label={G.send}>
              <Send className="size-4" aria-hidden />
              <span className="hidden sm:inline">{G.send}</span>
            </Button>
          )}
        </form>
      </section>
    </div>
  );
}

function MessageView({ m, rate }: { m: Msg; rate: number }) {
  const { t, locale } = useI18n();
  const G = t.gateway;
  const mine = m.role === 'user';
  return (
    <div className={cx('flex', mine ? 'justify-end' : 'justify-start')}>
      <div className={cx('max-w-[92%] sm:max-w-[80%]', mine ? 'items-end' : 'items-start')}>
        <div className="mb-1 text-xs text-muted">{mine ? G.you : G.assistant}</div>
        <div
          className={cx(
            'rounded-2xl px-4 py-2.5 text-[0.9375rem] leading-relaxed whitespace-pre-wrap break-words',
            mine ? 'bg-accent text-accent-fg' : 'bg-surface-2',
            m.streaming && !m.content && 'text-muted',
            m.streaming && m.content && 'caret',
          )}
        >
          {m.content || (m.streaming ? G.thinking : m.error ? '' : '…')}
        </div>
        {m.error && <p className="mt-1.5 text-sm text-danger">{m.error}</p>}
        {!mine && m.meta?.model && !m.streaming && (
          <div className="mt-1.5 space-y-0.5 text-xs text-muted">
            <div className="flex flex-wrap items-center gap-x-2">
              <span>
                {fmt(G.msgReceipt, {
                  model: m.meta.model,
                  provider: m.meta.provider ?? '—',
                  cost:
                    m.meta.costMicros != null
                      ? formatMicrosVnd(m.meta.costMicros, rate, locale, { precise: true })
                      : '—',
                })}
              </span>
              {m.meta.promptTokens != null && (
                <span>
                  ·{' '}
                  {fmt(G.msgTokens, {
                    prompt: formatNumber(m.meta.promptTokens, locale),
                    completion: formatNumber(m.meta.completionTokens ?? 0, locale),
                  })}
                  {m.meta.estimated ? ` (${t.receipt.estimated})` : ''}
                </span>
              )}
              {m.meta.genId && (
                <Link
                  href={`/console/gateway/requests/${encodeURIComponent(m.meta.genId)}`}
                  className="inline-flex items-center gap-0.5 text-accent hover:underline"
                >
                  {t.receipt.title}
                  <ExternalLink className="size-3" aria-hidden />
                </Link>
              )}
            </div>
            {m.meta.reason && (
              <div>
                {G.routingReason}: <span className="font-mono">{m.meta.reason}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
