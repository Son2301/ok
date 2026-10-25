import type { Metadata } from 'next';
import { CopyButton, LanguageToggle } from '@/components/client';
import { Badge, Card, CardBody, CardHeader, PageHeader } from '@/components/ui';
import { formatDate } from '@/lib/format';
import { getDictionary } from '@/lib/i18n';
import { getI18n, getLocale } from '@/lib/i18n/server';
import { listMembers } from '@/lib/org';
import { requireSession } from '@/lib/session';
import { OrgForm } from './org-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getDictionary(await getLocale()).settings.title };
}

export default async function SettingsPage() {
  const session = await requireSession();
  const { t, locale } = await getI18n();
  const S = t.settings;
  const members = await listMembers(session.org.id).catch(() => []);

  return (
    <>
      <PageHeader title={S.title} />
      <div className="grid gap-6">
        <Card>
          <CardHeader title={S.orgTitle} />
          <CardBody className="space-y-4">
            <OrgForm name={session.org.name} />
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
              {S.orgId}: <code className="font-mono text-xs text-fg">{session.org.id}</code>
              <CopyButton value={session.org.id} variant="ghost" iconOnly />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={S.membersTitle} description={S.membersBody} />
          <ul className="mt-3 divide-y divide-line border-t border-line">
            {members.map((m) => (
              <li key={m.userId} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {m.name || m.email}
                    {m.userId === session.user.id && (
                      <span className="ml-1.5 font-normal text-muted">({S.you})</span>
                    )}
                  </div>
                  <div className="truncate text-xs text-muted">
                    {m.email} · {formatDate(m.createdAt, locale)}
                  </div>
                </div>
                <Badge tone={m.role === 'owner' ? 'accent' : 'neutral'}>
                  {(S.role as Record<string, string>)[m.role] ?? m.role}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader title={S.languageTitle} description={S.languageBody} />
          <CardBody>
            <LanguageToggle />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
