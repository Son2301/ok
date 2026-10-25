import type { Metadata } from 'next';
import { ServiceProblem } from '@/components/console';
import { PageHeader } from '@/components/ui';
import { getDictionary } from '@/lib/i18n';
import { getI18n, getLocale } from '@/lib/i18n/server';
import { gatewayApi } from '@/lib/services';
import { requireSession } from '@/lib/session';
import { getWallet } from '@/lib/wallet';
import { type ModelOption, Playground } from './playground';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getDictionary(await getLocale()).gateway.playgroundTitle };
}

export default async function PlaygroundPage() {
  const session = await requireSession();
  const { t } = await getI18n();
  const [models, wallet] = await Promise.all([
    gatewayApi.models({ type: 'chat' }),
    getWallet(session.org.id),
  ]);

  return (
    <>
      <PageHeader title={t.gateway.playgroundTitle} description={t.gateway.playgroundSubtitle} />
      {models.ok ? (
        <Playground
          rate={wallet.summary.vndPerUsd}
          models={models.data.data
            .filter((m) => m.type === 'chat' && m.available)
            .map<ModelOption>((m) => ({
              id: m.id,
              name: m.name,
              group: m.id.startsWith('auto') ? 'auto' : 'model',
            }))}
        />
      ) : (
        <ServiceProblem error={models.error} t={t} />
      )}
    </>
  );
}
