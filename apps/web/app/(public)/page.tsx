import {
  ArrowRight,
  Bot,
  FileText,
  Gauge,
  GitPullRequest,
  Infinity as InfinityIcon,
  QrCode,
  ReceiptText,
  Route,
  ScanSearch,
  UserRound,
} from 'lucide-react';
import Link from 'next/link';
import { Badge, ButtonLink } from '@/components/ui';
import { env } from '@/lib/env';
import { fmt } from '@/lib/i18n';
import { getI18n } from '@/lib/i18n/server';

export default async function LandingPage() {
  const { t, locale } = await getI18n();
  const cfg = env();
  const L = t.landing;

  const products = [
    { id: 'gateway', icon: Route, href: '/models', p: t.products.gateway },
    { id: 'agents', icon: Bot, href: '/signup?next=/console/agents', p: t.products.agents },
    { id: 'safe', icon: ScanSearch, href: '/safe', p: t.products.safe },
    { id: 'review', icon: GitPullRequest, href: '/signup?next=/console/review', p: t.products.review },
  ] as const;

  const principles = [
    { icon: InfinityIcon, ...L.principles.neverExpire },
    { icon: QrCode, ...L.principles.vietqr },
    { icon: FileText, ...L.principles.invoice },
    { icon: Gauge, ...L.principles.caps },
    { icon: ReceiptText, ...L.principles.receipts },
    {
      icon: UserRound,
      title: L.principles.founder.title,
      body: fmt(L.principles.founder.body, { founder: cfg.founderName || L.principles.founder.placeholder }),
    },
  ];

  return (
    <>
      {/* Hero */}
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pt-14 pb-16 sm:px-6 lg:grid-cols-[1.15fr_1fr] lg:pt-20">
        <div>
          <p className="text-sm font-medium text-accent">{L.eyebrow}</p>
          <h1 className="mt-3 text-[2.15rem] leading-[1.15] font-semibold tracking-tight sm:text-5xl sm:leading-[1.08]">
            {L.title}
          </h1>
          <p className="mt-5 max-w-xl text-lg text-muted">{L.subtitle}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink href="/signup" size="lg">
              {L.ctaPrimary}
              <ArrowRight className="size-4" aria-hidden />
            </ButtonLink>
            <ButtonLink href="/safe" size="lg" variant="secondary">
              {L.ctaSecondary}
            </ButtonLink>
          </div>
          <p className="mt-4 text-sm text-muted">{L.ctaNoCard}</p>
        </div>

        {/* Illustration of the two moments we care about: money in, receipt out. */}
        <div aria-hidden className="relative mx-auto w-full max-w-md select-none">
          <div className="animate-pop rounded-2xl border border-line bg-surface p-5 shadow-pop">
            <div className="flex items-center gap-3">
              <div className="grid size-10 place-items-center rounded-full bg-ok-soft text-ok">
                <QrCode className="size-5" />
              </div>
              <div>
                <div className="font-semibold">
                  {locale === 'vi' ? 'Đã nhận 200.000đ' : 'Received ₫200,000'}
                </div>
                <div className="text-sm text-muted">
                  VietQR · {locale === 'vi' ? 'Số dư mới 245.300đ' : 'New balance ₫245,300'}
                </div>
              </div>
            </div>
          </div>
          <div className="mt-4 ml-6 rounded-2xl border border-line bg-surface p-5 shadow-pop sm:ml-10">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">{t.receipt.title}</div>
              <Badge tone="accent">Gateway</Badge>
            </div>
            <dl className="mt-3 space-y-2 text-sm">
              <Row label={t.receipt.model} value="anthropic/claude-sonnet-4.6" mono />
              <Row label={t.receipt.provider} value="anthropic" mono />
              <Row
                label={t.receipt.tokens}
                value={fmt(t.receipt.tokensDetail, { prompt: '812', completion: '240' })}
              />
              <Row label={t.receipt.cost} value={locale === 'vi' ? '18,6đ' : '₫18.6'} strong />
              <Row label={t.receipt.latency} value={locale === 'vi' ? '2,1 s' : '2.1 s'} />
            </dl>
          </div>
          <p className="mt-3 text-center text-xs text-faint">
            {locale === 'vi' ? 'Minh hoạ giao diện' : 'Interface illustration'}
          </p>
        </div>
      </section>

      {/* Products */}
      <section id="products" className="scroll-mt-20 border-t border-line bg-surface/60">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">{L.productsTitle}</h2>
          <p className="mt-2 max-w-2xl text-muted">{L.productsSubtitle}</p>
          <div className="mt-10 grid gap-4 sm:grid-cols-2">
            {products.map(({ id, icon: Icon, href, p }) => (
              <Link
                key={id}
                href={href}
                className="group flex flex-col rounded-2xl border border-line bg-surface p-6 shadow-card transition-colors hover:border-line-strong"
              >
                <div className="flex items-center gap-3">
                  <div className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent-ink">
                    <Icon className="size-5" aria-hidden />
                  </div>
                  <div>
                    <div className="font-semibold">{p.name}</div>
                    <div className="text-xs text-muted">{p.kicker}</div>
                  </div>
                </div>
                <h3 className="mt-5 text-lg font-semibold">{p.title}</h3>
                <p className="mt-2 flex-1 text-[0.9375rem] text-muted">{p.body}</p>
                <span className="mt-5 inline-flex items-center gap-1 text-sm font-medium text-accent">
                  {L.productLink}
                  <ArrowRight
                    className="size-4 transition-transform group-hover:translate-x-0.5"
                    aria-hidden
                  />
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Commitments */}
      <section id="principles" className="scroll-mt-20 border-t border-line">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">{L.principlesTitle}</h2>
          <p className="mt-2 max-w-2xl text-muted">{L.principlesSubtitle}</p>
          <ul className="mt-10 grid gap-x-8 gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
            {principles.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex gap-4">
                <Icon className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
                <div>
                  <h3 className="font-semibold">{title}</h3>
                  <p className="mt-1.5 text-[0.9375rem] text-muted">{body}</p>
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-12 rounded-2xl border border-dashed border-line-strong bg-surface p-6">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">{L.pledgeTitle}</h3>
              <Badge tone="warn">{t.common.draft}</Badge>
            </div>
            <p className="mt-2 max-w-3xl text-[0.9375rem] text-muted">{L.pledgeBody}</p>
            <p className="mt-2 text-xs text-faint">{L.pledgeDraftNote}</p>
          </div>
        </div>
      </section>

      {/* Models & safe */}
      <section className="border-t border-line bg-surface/60">
        <div className="mx-auto grid max-w-6xl gap-4 px-4 py-16 sm:px-6 md:grid-cols-2">
          <div className="rounded-2xl border border-line bg-surface p-6 shadow-card">
            <Route className="size-5 text-accent" aria-hidden />
            <h2 className="mt-4 text-lg font-semibold">{L.modelsTitle}</h2>
            <p className="mt-2 text-muted">{L.modelsBody}</p>
            <ButtonLink href="/models" variant="secondary" className="mt-5">
              {L.modelsCta}
            </ButtonLink>
          </div>
          <div className="rounded-2xl border border-line bg-surface p-6 shadow-card">
            <ScanSearch className="size-5 text-accent" aria-hidden />
            <h2 className="mt-4 text-lg font-semibold">{L.safeTitle}</h2>
            <p className="mt-2 text-muted">{L.safeBody}</p>
            <ButtonLink href="/safe" className="mt-5">
              {L.safeCta}
            </ButtonLink>
          </div>
        </div>
      </section>
    </>
  );
}

function Row({
  label,
  value,
  mono,
  strong,
}: {
  label: string;
  value: string;
  mono?: boolean;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd
        className={`${mono ? 'font-mono text-[0.8rem]' : ''} ${strong ? 'font-semibold' : ''} truncate tabular-nums`}
      >
        {value}
      </dd>
    </div>
  );
}
