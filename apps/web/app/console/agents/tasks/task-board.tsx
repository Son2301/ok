'use client';

import { Plus } from 'lucide-react';
import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import { SubmitButton } from '@/components/client';
import { useI18n } from '@/components/i18n-provider';
import { Badge, Button, Field, Notice } from '@/components/ui';
import { cx } from '@/lib/cx';
import type { Task, TaskStatus } from '@/lib/types/agents';
import { createTaskAction, type FormState, moveTaskAction } from '../actions';

const COLUMNS: TaskStatus[] = ['todo', 'in_progress', 'blocked', 'done'];
const PRIORITY_TONE = { low: 'neutral', medium: 'neutral', high: 'orange', urgent: 'danger' } as const;

export function NewTaskForm({ agents }: { agents: { id: string; name: string }[] }) {
  const { t } = useI18n();
  const A = t.agents;
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState<FormState, FormData>(createTaskAction, {});
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) {
      ref.current?.reset();
      setOpen(false);
    }
  }, [state]);
  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden />
        {A.newTask}
      </Button>
    );
  }
  return (
    <form
      ref={ref}
      action={action}
      className="grid gap-3 rounded-xl border border-line bg-surface p-4 shadow-card sm:grid-cols-[1fr_12rem_9rem]"
    >
      {state.error && (
        <Notice tone="danger" className="sm:col-span-3">
          {state.error}
        </Notice>
      )}
      <Field label={A.taskTitle} htmlFor="t-title">
        <input
          id="t-title"
          name="title"
          required
          maxLength={200}
          placeholder={A.taskTitlePlaceholder}
          className="input"
          ref={(el) => el?.focus()}
        />
      </Field>
      <Field label={A.taskAssignee} htmlFor="t-assignee">
        <select id="t-assignee" name="assignee" className="input">
          <option value="">{A.unassigned}</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={A.priorityLabel} htmlFor="t-priority">
        <select id="t-priority" name="priority" defaultValue="medium" className="input">
          {(['low', 'medium', 'high', 'urgent'] as const).map((p) => (
            <option key={p} value={p}>
              {A.priority[p]}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label={A.taskDescription}
        htmlFor="t-desc"
        className="sm:col-span-3"
        optionalLabel={t.common.optional}
      >
        <textarea id="t-desc" name="description" rows={2} maxLength={10_000} className="input text-sm" />
      </Field>
      <div className="flex gap-2 sm:col-span-3">
        <SubmitButton pendingLabel={t.common.saving}>{A.createTask}</SubmitButton>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          {t.common.cancel}
        </Button>
      </div>
    </form>
  );
}

export function TaskBoard({ tasks, agents }: { tasks: Task[]; agents: { id: string; name: string }[] }) {
  const { t } = useI18n();
  const A = t.agents;
  const names = new Map(agents.map((a) => [a.id, a.name]));
  const [pending, start] = useTransition();
  return (
    <div className={cx('grid gap-4 md:grid-cols-2 xl:grid-cols-4', pending && 'opacity-70')}>
      {COLUMNS.map((col) => {
        const items = tasks.filter((x) => x.status === col);
        return (
          <section key={col} className="rounded-xl bg-surface-2 p-3" aria-label={A.taskStatus[col]}>
            <h2 className="mb-3 flex items-center justify-between px-1 text-sm font-medium">
              {A.taskStatus[col]}
              <span className="text-xs text-muted tabular-nums">{items.length}</span>
            </h2>
            <ul className="space-y-2">
              {items.map((task) => (
                <li key={task.id} className="rounded-lg border border-line bg-surface p-3 shadow-card">
                  <div className="text-sm font-medium">{task.title}</div>
                  {task.description && (
                    <p className="mt-1 line-clamp-3 text-xs text-muted">{task.description}</p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <Badge tone={PRIORITY_TONE[task.priority]}>{A.priority[task.priority]}</Badge>
                    <span>
                      {task.assigneeAgentId
                        ? (names.get(task.assigneeAgentId) ?? task.assigneeAgentId)
                        : A.unassigned}
                    </span>
                  </div>
                  <label className="mt-2 flex items-center gap-2 text-xs text-muted">
                    <span className="shrink-0">{A.moveTo}</span>
                    <select
                      value={task.status}
                      onChange={(e) => {
                        const next = e.target.value as TaskStatus;
                        start(async () => void (await moveTaskAction(task.id, next)));
                      }}
                      className="input h-7 min-h-7 py-0 text-xs"
                    >
                      {COLUMNS.map((c) => (
                        <option key={c} value={c}>
                          {A.taskStatus[c]}
                        </option>
                      ))}
                    </select>
                  </label>
                </li>
              ))}
              {items.length === 0 && <li className="px-1 py-4 text-center text-xs text-faint">—</li>}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
