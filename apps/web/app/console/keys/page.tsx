import type { Metadata } from 'next';
import { CodeBlock } from '@/components/console';
import { Card, CardBody, CardHeader, PageHeader } from '@/components/ui';
import { env } from '@/lib/env';
import { getDictionary } from '@/lib/i18n';
import { getI18n, getLocale } from '@/lib/i18n/server';
import { listKeyViews } from '@/lib/keys';
import { requireSession } from '@/lib/session';
import { gatewayCurl, openaiSdkSnippet } from '@/lib/snippets';
import { getWallet } from '@/lib/wallet';
import { CreateKeyForm, KeyList } from './keys-ui';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getDictionary(await getLocale()).keys.title };
}

export default async function KeysPage() {
  const session = await requireSession();
  const { t } = await getI18n();
  const cfg = env();
  const [keys, wallet] = await Promise.all([listKeyViews(session.org.id), getWallet(session.org.id)]);
  const active = keys.filter((k) => !k.revokedAt).length;

  return (
    <>
      <PageHeader title={t.keys.title} description={t.keys.subtitle} />
      <div className="grid gap-6">
        <Card>
          <CardHeader title={t.keys.createTitle} />
          <CardBody>
            <CreateKeyForm baseUrl={cfg.publicApiUrl} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={t.keys.listTitle} />
          <div className="mt-4">
            <KeyList keys={keys} rate={wallet.summary.vndPerUsd} />
          </div>
        </Card>

        {active === 0 && (
          <Card>
            <CardHeader title={t.overview.curlTitle} description={t.overview.curlBody} />
            <CardBody className="space-y-3">
              <CodeBlock code={gatewayCurl(cfg.publicApiUrl)} />
              <CodeBlock code={openaiSdkSnippet(cfg.publicApiUrl)} label="typescript" />
            </CardBody>
          </Card>
        )}
      </div>
    </>
  );
}
