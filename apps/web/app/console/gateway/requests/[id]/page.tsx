import { ArrowLeft, CircleAlert, CircleCheck } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Money, Receipt, ServiceProblem } from '@/components/console';
import { Badge, Card, CardBody, CardHeader, Notice, PageHeader } from '@/components/ui';
import { formatDateTime, formatDuration, formatNumber, formatUsd } from '@/lib/format';
import { fmt, getDictionary } from '@/lib/i18n';
import { getI18n, getLocale } from '@/lib/i18n/server';
import { productName } from '@/lib/ledger';
import { platform } from '@/lib/platform';
import { gatewayApi } from '@/lib/services';
import { requireSession } from '@/lib/session';
import { gatewayStatusTone } from '@/lib/status';
import { getWallet } from '@/lib/wallet';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getDictionary(await getLocale()).gateway.requestTitle };
}

export default async function RequestReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { t, locale } = await getI18n();
  const { id } = await params;
  const G = t.gateway;
  const [res, wallet, keys] = await Promise.all([
    gatewayApi.generation(session.org.id, id),
    getWallet(session.org.id),
    platform().then(({ core }) => core.listApiKeys(session.org.id)),
  ]);
  const rate = wallet.summary.vndPerUsd;

  const back = (
    <Link
      href="/console/gateway/requests"
      className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
    >
      <ArrowLeft className="size-4" aria-hidden />
      {G.requestsTitle}
    </Link>
  );

  if (!res.ok) {
    return (
      <>
        {back}
        <PageHeader title={G.requestTitle} />
        {res.error.status === 404 ? (
          <Notice tone="neutral">{G.notFound}</Notice>
        ) : (
          <ServiceProblem error={res.error} t={t} />
        )}
      </>
    );
  }

  const g = res.data.data;
  const key = g.api_key_id ? keys.find((k) => k.id === g.api_key_id) : null;
  const reason = g.routing?.auto?.reason;

  return (
    <>
      {back}
      <PageHeader
        title={G.requestTitle}
        description={<span className="font-mono text-xs">{g.id}</span>}
        action={
          <Badge tone={gatewayStatusTone(g.status)} dot>
            {G.status[g.status] ?? g.status}
          </Badge>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Receipt
          title={t.receipt.title}
          rows={[
            { label: t.receipt.what, value: `${g.kind} · ${productName(g.product, t)}` },
            { label: G.requested, value: <span className="font-mono text-xs">{g.requested_model}</span> },
            {
              label: G.answered,
              value: <span className="font-mono text-xs">{g.model ?? '—'}</span>,
              strong: true,
            },
            { label: t.receipt.provider, value: g.provider ?? '—', strong: true },
            {
              label: t.receipt.tokens,
              value: `${fmt(t.receipt.tokensDetail, {
                prompt: formatNumber(g.usage.prompt_tokens, locale),
                completion: formatNumber(g.usage.completion_tokens, locale),
              })}${g.usage.estimated ? ` (${t.receipt.estimated})` : ''}`,
            },
            {
              label: t.receipt.cost,
              value: (
                <>
                  <Money micros={g.cost_micros} rate={rate} locale={locale} precise />
                  <span className="ml-1.5 text-xs font-normal text-muted">{formatUsd(g.cost_micros)}</span>
                </>
              ),
              strong: true,
            },
            { label: t.receipt.latency, value: formatDuration(g.latency_ms, locale) },
            ...(g.ttft_ms != null
              ? [{ label: t.receipt.ttft, value: formatDuration(g.ttft_ms, locale) }]
              : []),
            { label: t.receipt.when, value: formatDateTime(g.created_at, locale) },
            { label: t.receipt.apiKey, value: key ? `${key.name} (${key.prefix})` : t.receipt.internal },
            ...(g.finish_reason ? [{ label: G.finishReason, value: g.finish_reason }] : []),
            { label: G.streamed, value: g.stream ? t.common.yes : t.common.no },
          ]}
        />

        <div className="space-y-4">
          {reason && (
            <Card>
              <CardHeader title={G.routingReason} />
              <CardBody className="pt-3">
                <p className="font-mono text-sm">{reason}</p>
                {g.routing?.auto?.tier && (
                  <p className="mt-2 text-xs text-muted">
                    tier: {g.routing.auto.tier}
                    {g.routing.auto.variant ? ` · ${g.routing.auto.variant}` : ''}
                  </p>
                )}
              </CardBody>
            </Card>
          )}
          {g.error && (
            <Notice tone="danger" title={G.errorMessage}>
              {g.error}
            </Notice>
          )}
          <Card>
            <CardHeader title={G.attemptsTitle} description={G.attemptsBody} />
            <CardBody>
              <ol className="space-y-3">
                {g.attempts.map((a, i) => {
                  const ok = a.status === 'success';
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: attempts are ordered and immutable
                    <li key={i} className="flex gap-3">
                      <div className="flex flex-col items-center">
                        {ok ? (
                          <CircleCheck className="size-5 text-ok" aria-label={G.attemptOk} />
                        ) : (
                          <CircleAlert className="size-5 text-danger" aria-label={G.attemptFailed} />
                        )}
                        {i < g.attempts.length - 1 && (
                          <span aria-hidden className="mt-1 w-px flex-1 bg-line" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1 pb-1">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="font-mono text-xs">{a.endpoint}</span>
                          <span className="text-xs text-muted tabular-nums">
                            {formatDuration(a.latency_ms ?? null, locale)}
                          </span>
                        </div>
                        {!ok && (
                          <div className="mt-1 text-sm text-danger">
                            {[a.error_kind, a.http_status ? `HTTP ${a.http_status}` : null, a.error]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
                {g.attempts.length === 0 && <li className="text-sm text-muted">—</li>}
              </ol>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
