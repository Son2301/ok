import type { Metadata } from 'next';
import { ServiceProblem } from '@/components/console';
import { PageHeader } from '@/components/ui';
import { getDictionary } from '@/lib/i18n';
import { getI18n, getLocale } from '@/lib/i18n/server';
import { agentsApi } from '@/lib/services';
import { requireSession } from '@/lib/session';
import { NewTaskForm, TaskBoard } from './task-board';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getDictionary(await getLocale()).agents.tasksTitle };
}

export default async function TasksPage() {
  const session = await requireSession();
  const { t } = await getI18n();
  const [tasks, agents] = await Promise.all([
    agentsApi.tasks(session.org.id, { limit: 200 }),
    agentsApi.list(session.org.id),
  ]);
  const agentList = agents.ok ? agents.data.data.map((a) => ({ id: a.id, name: a.name })) : [];
  return (
    <>
      <PageHeader title={t.agents.tasksTitle} action={tasks.ok && <NewTaskForm agents={agentList} />} />
      {tasks.ok ? (
        <>
          {tasks.data.data.length === 0 && <p className="mb-4 text-sm text-muted">{t.agents.tasksEmpty}</p>}
          <TaskBoard tasks={tasks.data.data} agents={agentList} />
        </>
      ) : (
        <ServiceProblem error={tasks.error} t={t} />
      )}
    </>
  );
}
