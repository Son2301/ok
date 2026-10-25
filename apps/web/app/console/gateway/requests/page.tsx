import { List } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Money, ServiceProblem } from '@/components/console';
import { Badge, ButtonLink, Card, EmptyState, PageHeader, Table, Td, Th } from '@/components/ui';
import { formatDateTime, formatDuration, formatTokens } from '@/lib/format';
import { fmt, getDictionary } from '@/lib/i18n';
import { getI18n, getLocale } from '@/lib/i18n/server';
import { productName } from '@/lib/ledger';
import { gatewayApi } from '@/lib/services';
import { requireSession } from '@/lib/session';
import { gatewayStatusTone } from '@/lib/status';
import { getWallet } from '@/lib/wallet';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getDictionary(await getLocale()).gateway.requestsTitle };
}

const STATUSES = ['success', 'error', 'partial', 'aborted'] as const;

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; cursor?: string; model?: string }>;
}) {
  const session = await requireSession();
  const { t, locale } = await getI18n();
  const sp = await searchParams;
  const G = t.gateway;
  const status = (STATUSES as readonly string[]).includes(sp.status ?? '') ? sp.status : undefined;
  const model = sp.model?.slice(0, 200) || undefined;

  const [res, wallet] = await Promise.all([
    gatewayApi.requests(session.org.id, { limit: 50, cursor: sp.cursor, status, model }),
    getWallet(session.org.id),
  ]);
  const rate = wallet.summary.vndPerUsd;
  const qs = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ status, model, ...extra })) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  return (
    <>
      <PageHeader title={G.requestsTitle} description={G.requestsSubtitle} />

      <nav aria-label={G.filterStatus} className="mb-4 flex flex-wrap items-center gap-1.5">
        {[undefined, ...STATUSES].map((s) => (
          <Link
            key={s ?? 'all'}
            href={`/console/gateway/requests${qs({ status: s })}`}
            aria-current={status === s ? 'page' : undefined}
            className={`rounded-full border px-3 py-1 text-sm ${
              status === s
                ? 'border-accent bg-accent-soft text-accent-ink'
                : 'border-line text-muted hover:text-fg'
            }`}
          >
            {s ? G.status[s] : t.common.all}
          </Link>
        ))}
        {model && (
          <Link
            href={`/console/gateway/requests${qs({ model: undefined })}`}
            className="ml-1 text-sm text-accent hover:underline"
          >
            {G.filterModel}: <span className="font-mono">{model}</span> ✕
          </Link>
        )}
      </nav>

      <Card>
        {!res.ok ? (
          <div className="p-5">
            <ServiceProblem error={res.error} t={t} />
          </div>
        ) : res.data.data.length === 0 ? (
          <EmptyState
            icon={<List className="size-5" />}
            title={G.requestsEmpty}
            action={<ButtonLink href="/console/gateway/playground">{t.overview.quick.playground}</ButtonLink>}
          />
        ) : (
          <>
            <Table label={G.requestsTitle}>
              <thead>
                <tr>
                  <Th>{G.colTime}</Th>
                  <Th>{G.colModel}</Th>
                  <Th>{G.colStatus}</Th>
                  <Th align="right">{t.receipt.tokens}</Th>
                  <Th align="right">{G.colLatency}</Th>
                  <Th align="right">{G.colCost}</Th>
                </tr>
              </thead>
              <tbody>
                {res.data.data.map((r) => (
                  <tr key={r.id} className="hover:bg-surface-2">
                    <Td className="whitespace-nowrap">
                      <Link
                        href={`/console/gateway/requests/${encodeURIComponent(r.id)}`}
                        className="text-accent hover:underline"
                      >
                        {formatDateTime(r.created_at, locale)}
                      </Link>
                      <div className="mt-0.5 text-xs text-muted">{productName(r.product, t)}</div>
                    </Td>
                    <Td className="min-w-48">
                      <div className="font-mono text-xs">{r.model ?? r.requested_model}</div>
                      <div className="mt-0.5 text-xs text-muted">
                        {r.provider ?? '—'}
                        {r.requested_model !== r.model && r.model ? ` · ${r.requested_model}` : ''}
                        {r.attempt_count > 1 ? ` · ${fmt(G.fallbacks, { n: r.attempt_count - 1 })}` : ''}
                      </div>
                    </Td>
                    <Td>
                      <Badge tone={gatewayStatusTone(r.status)} dot>
                        {G.status[r.status] ?? r.status}
                      </Badge>
                    </Td>
                    <Td align="right" className="whitespace-nowrap">
                      {formatTokens(r.usage.prompt_tokens, locale)} →{' '}
                      {formatTokens(r.usage.completion_tokens, locale)}
                    </Td>
                    <Td align="right">{formatDuration(r.latency_ms, locale)}</Td>
                    <Td align="right" className="font-medium">
                      <Money micros={r.cost_micros} rate={rate} locale={locale} precise />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {(sp.cursor || res.data.next_cursor) && (
              <div className="flex justify-between px-5 py-3 text-sm">
                {sp.cursor ? (
                  <Link href={`/console/gateway/requests${qs({})}`} className="text-accent hover:underline">
                    ← {t.common.newer}
                  </Link>
                ) : (
                  <span />
                )}
                {res.data.next_cursor && (
                  <Link
                    href={`/console/gateway/requests${qs({ cursor: res.data.next_cursor })}`}
                    className="text-accent hover:underline"
                  >
                    {t.common.older} →
                  </Link>
                )}
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}
