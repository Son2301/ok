import type { Metadata } from 'next';
import { ServiceProblem } from '@/components/console';
import { Card, CardBody, PageHeader } from '@/components/ui';
import { getDictionary } from '@/lib/i18n';
import { getI18n, getLocale } from '@/lib/i18n/server';
import { agentsApi, gatewayApi } from '@/lib/services';
import { requireSession } from '@/lib/session';
import { getWallet } from '@/lib/wallet';
import { CreateAgentForm } from './create-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getDictionary(await getLocale()).agents.createTitle };
}

export default async function NewAgentPage() {
  const session = await requireSession();
  const { t } = await getI18n();
  const orgId = session.org.id;
  const [plans, agents, models, wallet] = await Promise.all([
    agentsApi.plans(orgId),
    agentsApi.list(orgId),
    gatewayApi.models({ type: 'chat' }),
    getWallet(orgId),
  ]);
  const modelIds = models.ok
    ? models.data.data.filter((m) => m.available).map((m) => m.id)
    : ['auto', 'auto:cheap', 'auto:best'];

  return (
    <>
      <PageHeader title={t.agents.createTitle} description={t.agents.createSubtitle} />
      {!plans.ok ? (
        <ServiceProblem error={plans.error} t={t} />
      ) : (
        <Card>
          <CardBody>
            <CreateAgentForm
              plans={plans.data.data}
              agents={agents.ok ? agents.data.data.map((a) => ({ id: a.id, name: a.name })) : []}
              models={modelIds}
              rate={wallet.summary.vndPerUsd}
            />
          </CardBody>
        </Card>
      )}
    </>
  );
}
