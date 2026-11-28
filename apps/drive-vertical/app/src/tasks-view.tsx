/**
 * The space's to-do list (`drive/list-tasks` and friends in `@canopy/scope-drive`).
 *
 * One list per space, shared like the space: whoever reads the space reads it, and an editor
 * adds, ticks off and changes tasks. A tick is sent at once and shown at once; if someone else
 * changed the task meanwhile the scope refuses (409) and the list is read again, so two people
 * never silently overwrite each other.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Icon, Input, cn,
} from '@canopy/ui';
import { ApiError, createTask, deleteTask, listTasks, updateTask, type Task } from './api';
import { dueLabel, today } from './schedule-dates';

/** A refusal in words: a stale edit is a reason to look again, not an error to puzzle over. */
export function scheduleErrorText(error: unknown, what: 'task' | 'event'): string {
  if (error instanceof ApiError && error.status === 409) return `Someone changed this ${what} in the meantime. Showing the latest.`;
  if (error instanceof ApiError && error.status === 403) return `You can see this space’s ${what === 'task' ? 'tasks' : 'calendar'}, but not change them.`;
  return error instanceof Error ? error.message : String(error);
}
const isConflict = (error: unknown) => error instanceof ApiError && error.status === 409;

export function DueBadge({ due, done = false }: { due: string; done?: boolean }) {
  const label = dueLabel(due, today());
  return <span className={cn('inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs',
    label.overdue && !done ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground')}>
    <Icon name="calendar" size={12} />{label.text}
  </span>;
}

export function TasksView() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Task | null>(null);
  // Ticked off here since the last read: they stay where they were, struck through, until the
  // list is read again — a row that vanishes under the pointer cannot be unticked.
  const [lingering, setLingering] = useState<ReadonlySet<string>>(new Set());
  const reads = useRef(0);

  const reload = useCallback(async () => {
    const read = ++reads.current;
    try {
      const result = await listTasks(showDone ? 'all' : 'open');
      if (read !== reads.current) return;
      setTasks(result.tasks);
      setCanWrite(result.canWrite);
      setLingering(new Set());
    } catch (e) {
      if (read === reads.current) { setTasks(current => current ?? []); setError(scheduleErrorText(e, 'task')); }
    }
  }, [showDone]);
  useEffect(() => { void reload(); }, [reload]);

  const replace = (task: Task) => setTasks(current => current?.map(t => (t.id === task.id ? task : t)) ?? null);
  const fail = (e: unknown) => { setError(scheduleErrorText(e, 'task')); void reload(); };

  const toggle = async (task: Task) => {
    const status = task.status === 'completed' ? 'needs-action' : 'completed';
    setError(null);
    if (status === 'completed') setLingering(current => new Set(current).add(task.id));
    replace({ ...task, status });
    try {
      replace(await updateTask(task.id, task.revision, { status }));
    } catch (e) { fail(e); }
  };

  const finished = (t: Task) => t.status === 'completed' || t.status === 'cancelled';
  const open = tasks?.filter(t => !finished(t) || lingering.has(t.id)) ?? [];
  const done = tasks?.filter(t => finished(t) && !lingering.has(t.id)) ?? [];

  return <section aria-label="Tasks" className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border bg-card">
    <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
      <Icon name="check-square" size={18} />
      <h2 className="min-w-0 flex-1 truncate font-medium">Tasks</h2>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <Checkbox checked={showDone} onCheckedChange={value => setShowDone(value === true)} aria-label="Show completed" />
        Show completed
      </label>
    </header>
    {canWrite ? <NewTaskForm onCreated={task => { setTasks(current => [task, ...(current ?? [])]); void reload(); }} onError={fail} /> : null}
    {error ? <p role="alert" className="mx-4 mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
      {tasks === null ? <p role="status" className="px-2 py-4 text-sm text-muted-foreground">Loading tasks…</p>
        : open.length === 0 && done.length === 0 ? <div className="grid place-items-center gap-2 px-4 py-12 text-center">
          <Icon name="check-square" size={28} className="text-muted-foreground" />
          <p className="font-medium">Nothing to do</p>
          <p className="max-w-sm text-sm text-muted-foreground">{canWrite ? 'Add the first task above. Everyone in this space sees the same list.' : 'When someone adds a task to this space, it shows up here.'}</p>
        </div>
        : <>
          <TaskList tasks={open} canWrite={canWrite} onToggle={toggle} onOpen={setEditing} />
          {showDone && done.length > 0 ? <>
            <h3 className="px-2 pb-1 pt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">Completed</h3>
            <TaskList tasks={done} canWrite={canWrite} onToggle={toggle} onOpen={setEditing} />
          </> : null}
        </>}
    </div>
    {editing ? <TaskDialog task={editing} canWrite={canWrite} onClose={() => setEditing(null)}
      onSaved={task => { replace(task); setEditing(null); void reload(); }}
      onDeleted={id => { setTasks(current => current?.filter(t => t.id !== id) ?? null); setEditing(null); }}
      onConflict={() => { setEditing(null); setError(scheduleErrorText(new ApiError(409, ''), 'task')); void reload(); }} /> : null}
  </section>;
}

function TaskList({ tasks, canWrite, onToggle, onOpen }: {
  tasks: Task[]; canWrite: boolean; onToggle: (task: Task) => void; onOpen: (task: Task) => void;
}) {
  return <ul className="flex flex-col">
    {tasks.map(task => {
      const done = task.status === 'completed' || task.status === 'cancelled';
      return <li key={task.id} className="group flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent/60">
        <Checkbox checked={task.status === 'completed'} disabled={!canWrite} onCheckedChange={() => onToggle(task)}
          aria-label={`${task.status === 'completed' ? 'Mark as not done' : 'Mark as done'}: ${task.title}`} />
        <button type="button" onClick={() => onOpen(task)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span className={cn('min-w-0 flex-1 truncate text-sm', done && 'text-muted-foreground line-through')}>{task.title}</span>
          {task.notes ? <Icon name="note" size={14} className="shrink-0 text-muted-foreground" aria-label="Has notes" /> : null}
          {task.due ? <DueBadge due={task.due} done={done} /> : null}
        </button>
      </li>;
    })}
  </ul>;
}

function NewTaskForm({ onCreated, onError }: { onCreated: (task: Task) => void; onError: (e: unknown) => void }) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      onCreated(await createTask({ title: trimmed, due: due || null }));
      setTitle(''); setDue('');
      input.current?.focus();
    } catch (e) { onError(e); }
    finally { setBusy(false); }
  };
  return <form onSubmit={e => { e.preventDefault(); void submit(); }} className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
    <Input ref={input} value={title} onChange={e => setTitle(e.currentTarget.value)} placeholder="Add a task" aria-label="New task" maxLength={500} disabled={busy} className="min-w-48 flex-1" />
    <Input type="date" value={due} onChange={e => setDue(e.currentTarget.value)} aria-label="Due date" disabled={busy} className="w-40" />
    <Button type="submit" size="sm" disabled={busy || !title.trim()}><Icon name="plus" size={15} /> Add</Button>
  </form>;
}

/** One task, opened: change its title, date and notes, or remove it. Read-only for a viewer. */
export function TaskDialog({ task, canWrite, onClose, onSaved, onDeleted, onConflict }: {
  task: Task; canWrite: boolean; onClose: () => void; onSaved: (task: Task) => void; onDeleted: (id: string) => void; onConflict: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [due, setDue] = useState(task.due ?? '');
  const [notes, setNotes] = useState(task.notes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await work(); }
    catch (e) { if (isConflict(e)) onConflict(); else setError(scheduleErrorText(e, 'task')); }
    finally { setBusy(false); }
  };
  const save = () => run(async () => {
    onSaved(await updateTask(task.id, task.revision, { title: title.trim(), due: due || null, notes }));
  });
  const remove = () => run(async () => { await deleteTask(task.id); onDeleted(task.id); });
  return <Dialog open onOpenChange={next => { if (!next && !busy) onClose(); }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{canWrite ? 'Edit task' : 'Task'}</DialogTitle>
        <DialogDescription>{task.status === 'completed' ? 'Done.' : 'Open.'} Everyone in this space sees this task.</DialogDescription>
      </DialogHeader>
      <form onSubmit={e => { e.preventDefault(); void save(); }} className="space-y-3">
        <label className="block space-y-1 text-sm"><span className="font-medium">Title</span>
          <Input autoFocus value={title} onChange={e => setTitle(e.currentTarget.value)} maxLength={500} disabled={busy || !canWrite} /></label>
        <label className="block space-y-1 text-sm"><span className="font-medium">Due</span>
          <Input type="date" value={due} onChange={e => setDue(e.currentTarget.value)} disabled={busy || !canWrite} /></label>
        <label className="block space-y-1 text-sm"><span className="font-medium">Notes</span>
          <textarea value={notes} onChange={e => setNotes(e.currentTarget.value)} maxLength={10_000} rows={4} disabled={busy || !canWrite}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50" /></label>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter className="gap-2 sm:justify-between">
          {canWrite ? <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void remove()}><Icon name="trash" size={14} /> Delete</Button> : <span />}
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onClose}>{canWrite ? 'Cancel' : 'Close'}</Button>
            {canWrite ? <Button type="submit" size="sm" disabled={busy || !title.trim()}>{busy ? 'Saving…' : 'Save'}</Button> : null}
          </div>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
