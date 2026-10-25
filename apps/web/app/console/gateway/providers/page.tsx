import type { Metadata } from 'next';
import { ServiceProblem } from '@/components/console';
import { Badge, Card, EmptyState, Notice, PageHeader, Table, Td, Th } from '@/components/ui';
import { formatDuration, formatNumber, formatPercent } from '@/lib/format';
import { getDictionary } from '@/lib/i18n';
import { getI18n, getLocale } from '@/lib/i18n/server';
import { gatewayApi } from '@/lib/services';
import { requireSession } from '@/lib/session';
import type { GwEndpointHealth } from '@/lib/types/gateway';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getDictionary(await getLocale()).gateway.providersTitle };
}

export default async function ProvidersPage() {
  const session = await requireSession();
  const { t, locale } = await getI18n();
  const G = t.gateway;
  const [res, health] = await Promise.all([gatewayApi.providersHealth(session.org.id), gatewayApi.health()]);

  const circuit = (e: GwEndpointHealth) => {
    if (e.circuit === 'open')
      return (
        <Badge tone="danger" dot>
          {G.circuit.open}
        </Badge>
      );
    if (e.circuit === 'half_open')
      return (
        <Badge tone="warn" dot>
          {G.circuit.half_open}
        </Badge>
      );
    if (e.degraded)
      return (
        <Badge tone="warn" dot>
          {G.degraded}
        </Badge>
      );
    return (
      <Badge tone="ok" dot>
        {G.circuit.closed}
      </Badge>
    );
  };

  return (
    <>
      <PageHeader title={G.providersTitle} description={G.providersSubtitle} />
      {health.ok && health.data.mock_fallback && (
        <Notice tone="warn" className="mb-4">
          {G.mockNotice}
        </Notice>
      )}
      <Card>
        {!res.ok ? (
          <div className="p-5">
            <ServiceProblem error={res.error} t={t} />
          </div>
        ) : res.data.data.length === 0 ? (
          <EmptyState title={G.providersEmpty} />
        ) : (
          <Table label={G.providersTitle}>
            <thead>
              <tr>
                <Th>{G.colEndpoint}</Th>
                <Th>{G.colCircuit}</Th>
                <Th align="right">{G.colSuccess}</Th>
                <Th align="right">{G.colP50}</Th>
                <Th align="right">{G.colTtft}</Th>
                <Th align="right">{G.colTps}</Th>
              </tr>
            </thead>
            <tbody>
              {[...res.data.data]
                .sort((a, b) => b.requests - a.requests || a.endpoint.localeCompare(b.endpoint))
                .map((e) => (
                  <tr key={e.endpoint}>
                    <Td className="min-w-56">
                      <div className="font-mono text-xs">{e.model}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                        {e.provider}
                        {!e.verified && (
                          <Badge tone="neutral" title={t.models.unverifiedHint}>
                            {t.models.unverified}
                          </Badge>
                        )}
                      </div>
                    </Td>
                    <Td>{circuit(e)}</Td>
                    <Td align="right">
                      {e.requests === 0 || e.success_rate == null ? (
                        <span className="text-muted">{G.noData}</span>
                      ) : (
                        <>
                          {formatPercent(e.success_rate, locale, 1)}
                          <div className="text-xs text-muted">{formatNumber(e.requests, locale)} req</div>
                        </>
                      )}
                    </Td>
                    <Td align="right" className="whitespace-nowrap">
                      {e.p50_latency_ms == null
                        ? '—'
                        : `${formatDuration(e.p50_latency_ms, locale)} / ${formatDuration(e.p95_latency_ms, locale)}`}
                    </Td>
                    <Td align="right">{formatDuration(e.p50_ttft_ms, locale)}</Td>
                    <Td align="right">
                      {e.tokens_per_sec == null ? '—' : formatNumber(e.tokens_per_sec, locale, 1)}
                    </Td>
                  </tr>
                ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
