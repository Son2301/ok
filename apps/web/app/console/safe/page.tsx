import { ScanSearch } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { CodeBlock, Money, ServiceProblem } from '@/components/console';
import {
  Badge,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageHeader,
  Table,
  Td,
  Th,
} from '@/components/ui';
import { env } from '@/lib/env';
import { formatDateTime, formatMicrosVnd, formatNumber } from '@/lib/format';
import { fmt, getDictionary } from '@/lib/i18n';
import { getI18n, getLocale } from '@/lib/i18n/server';
import { safeApi } from '@/lib/services';
import { requireSession } from '@/lib/session';
import { safeCurl } from '@/lib/snippets';
import { riskTone } from '@/lib/status';
import { MEDIA_KINDS } from '@/lib/types/safe';
import { getWallet, spendByProduct } from '@/lib/wallet';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getDictionary(await getLocale()).safeConsole.title };
}

export default async function SafeConsolePage({
  searchParams,
}: {
  searchParams: Promise<{ before?: string }>;
}) {
  const session = await requireSession();
  const { t, locale } = await getI18n();
  const sp = await searchParams;
  const C = t.safeConsole;
  const orgId = session.org.id;
  const [history, pricing, wallet, spend] = await Promise.all([
    safeApi.history(orgId, { limit: 30, before: sp.before }),
    safeApi.pricing(),
    getWallet(orgId),
    spendByProduct(orgId, 30),
  ]);
  const rate = wallet.summary.vndPerUsd;
  const safeSpend = spend.find((s) => s.product === 'safe');

  return (
    <>
      <PageHeader
        title={C.title}
        description={C.subtitle}
        action={
          <ButtonLink href="/safe">
            <ScanSearch className="size-4" aria-hidden />
            {C.checkNow}
          </ButtonLink>
        }
      />

      <Card>
        <CardHeader title={C.historyTitle} />
        <div className="mt-3">
          {!history.ok ? (
            <div className="px-5 pb-5">
              <ServiceProblem error={history.error} t={t} />
            </div>
          ) : history.data.data.length === 0 ? (
            <EmptyState
              icon={<ScanSearch className="size-5" />}
              title={C.historyEmpty}
              action={
                <ButtonLink href="/safe" variant="secondary">
                  {C.checkNow}
                </ButtonLink>
              }
            />
          ) : (
            <>
              <Table label={C.historyTitle}>
                <thead>
                  <tr>
                    <Th>{C.colWhen}</Th>
                    <Th>{C.colInput}</Th>
                    <Th>{C.colLevel}</Th>
                    <Th>{C.colVia}</Th>
                    <Th align="right">{C.colCost}</Th>
                  </tr>
                </thead>
                <tbody>
                  {history.data.data.map((r) => {
                    const media = MEDIA_KINDS.includes(r.kind) || r.kind === 'ai_text';
                    return (
                      <tr key={r.id} className="hover:bg-surface-2">
                        <Td className="whitespace-nowrap">
                          <Link
                            href={`/console/safe/checks/${encodeURIComponent(r.id)}`}
                            className="text-accent hover:underline"
                          >
                            {formatDateTime(r.createdAt, locale)}
                          </Link>
                        </Td>
                        <Td className="max-w-72">
                          <div className="truncate font-mono text-xs">{r.inputPreview ?? '—'}</div>
                          <div className="text-xs text-muted">{t.safe.kind[r.kind]}</div>
                        </Td>
                        <Td>
                          <Badge tone={riskTone(r.level)} dot>
                            {(media ? t.safe.headlineMedia : t.safe.headline)[r.level]} · {r.score}
                          </Badge>
                        </Td>
                        <Td className="text-muted">{(C.via as Record<string, string>)[r.via] ?? r.via}</Td>
                        <Td align="right">
                          {r.chargedMicros ? (
                            <Money micros={r.chargedMicros} rate={rate} locale={locale} precise />
                          ) : (
                            <span className="text-muted">{t.common.free}</span>
                          )}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
              {history.data.nextBefore && history.data.data.length >= 30 && (
                <div className="flex justify-end px-5 py-3 text-sm">
                  <Link
                    href={`/console/safe?before=${encodeURIComponent(history.data.nextBefore)}`}
                    className="text-accent hover:underline"
                  >
                    {t.common.older} →
                  </Link>
                </div>
              )}
            </>
          )}
        </div>
      </Card>

      <Card className="mt-6">
        <CardHeader
          title={C.apiTitle}
          description={C.apiBody}
          action={
            <ButtonLink href="/console/keys" variant="secondary" size="sm">
              {C.createKey}
            </ButtonLink>
          }
        />
        <CardBody className="space-y-5">
          <p className="text-sm">
            {fmt(C.apiSpend, {
              cost: formatMicrosVnd(safeSpend?.micros ?? 0, rate, locale, { precise: true }),
              n: formatNumber(safeSpend?.count ?? 0, locale),
            })}
          </p>
          {pricing.ok && (
            <div>
              <h3 className="text-sm font-medium">{C.priceTitle}</h3>
              <ul className="mt-2 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
                {Object.entries(pricing.data.perCheck).map(([kind, micros]) => (
                  <li key={kind} className="flex justify-between gap-3">
                    <span className="text-muted">
                      {(t.safe.kind as Record<string, string>)[kind] ?? kind}
                    </span>
                    <span className="tabular-nums">
                      {formatMicrosVnd(micros ?? 0, rate, locale, { precise: true })}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-muted">
                {fmt(C.freeTier, { n: pricing.data.freeTier.checksPerDay })}
              </p>
            </div>
          )}
          <CodeBlock code={safeCurl(env().publicSafeUrl)} />
        </CardBody>
      </Card>
    </>
  );
}
