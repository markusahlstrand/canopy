/**
 * The space's calendar (`drive/calendar` and friends in `@canopy/scope-drive`): a month, Monday
 * first, with the space's events and the open tasks due on each day.
 *
 * A task is not copied into the calendar. It shows on its due date because the calendar reads
 * tasks by date, so changing the date in the list moves it here too.
 *
 * Times are the viewer's: an all-day event sits on its dates for everyone, and a timed event is
 * placed in the zone of whoever is looking.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Icon, Input, cn,
} from '@canopy/ui';
import { ApiError, createEvent, deleteEvent, readCalendar, updateEvent, type CalendarEvent, type EventInput, type Task } from './api';
import {
  addDays, addMonths, dateAt, eventDays, formatLongDay, formatMonth, formatTime, instantOf, localDateOf, localTimeOf,
  monthGrid, monthOf, today, touches, viewerTimeZone, weekdayNames,
} from './schedule-dates';
import { scheduleErrorText, TaskDialog } from './tasks-view';

/** How many entries a day cell lists before it says how many more there are. */
const CELL_ENTRIES = 3;

type Editing = { kind: 'new'; day: string } | { kind: 'event'; event: CalendarEvent } | { kind: 'task'; task: Task } | { kind: 'day'; day: string };

export function CalendarView({ initialMonth }: { initialMonth?: string } = {}) {
  const [month, setMonth] = useState(() => monthOf(initialMonth ?? today()));
  const [data, setData] = useState<{ events: CalendarEvent[]; tasks: Task[]; canWrite: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const days = useMemo(() => monthGrid(month), [month]);
  const reads = useRef(0);

  const reload = useCallback(async () => {
    const read = ++reads.current;
    try {
      const result = await readCalendar(days[0]!, addDays(days[days.length - 1]!, 1));
      if (read === reads.current) setData(result);
    } catch (e) {
      if (read === reads.current) { setData(current => current ?? { events: [], tasks: [], canWrite: false }); setError(scheduleErrorText(e, 'event')); }
    }
  }, [days]);
  useEffect(() => { void reload(); }, [reload]);

  const canWrite = data?.canWrite ?? false;
  const now = today();
  const entriesOn = (day: string) => ({
    events: (data?.events ?? []).filter(event => touches(event, day))
      // All-day first, then by time: the order a day is read in.
      .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start)),
    tasks: (data?.tasks ?? []).filter(task => task.due === day),
  });
  const done = (message?: string) => { setEditing(null); if (message) setError(message); void reload(); };

  return <section aria-label="Calendar" className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border bg-card">
    <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
      <Icon name="calendar" size={18} />
      <h2 className="min-w-0 flex-1 truncate font-medium" aria-live="polite">{formatMonth(month)}</h2>
      <Button size="sm" variant="outline" onClick={() => setMonth(monthOf(now))}>Today</Button>
      <Button size="icon" variant="ghost" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}><Icon name="chevron-left" size={16} /></Button>
      <Button size="icon" variant="ghost" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}><Icon name="chevron-right" size={16} /></Button>
      {canWrite ? <Button size="sm" onClick={() => setEditing({ kind: 'new', day: month === monthOf(now) ? now : month })}><Icon name="plus" size={15} /> New event</Button> : null}
    </header>
    {error ? <p role="alert" className="mx-4 mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-2">
      {/* Six weeks share the height there is, down to a row that still fits two entries. */}
      <div role="grid" aria-label={formatMonth(month)} className="grid min-h-0 min-w-[560px] flex-1 grid-cols-7 grid-rows-[auto_repeat(6,minmax(4.5rem,1fr))] overflow-hidden rounded-md border">
        <div role="row" className="contents">
          {weekdayNames().map(name => <div key={name} role="columnheader" className="border-b bg-muted/40 px-2 py-1 text-xs font-medium text-muted-foreground">{name}</div>)}
        </div>
        {Array.from({ length: 6 }, (_, week) => <div key={week} role="row" className="contents">
          {days.slice(week * 7, week * 7 + 7).map(day => {
            const { events, tasks } = entriesOn(day);
            const entries = events.length + tasks.length;
            const shown = { events: events.slice(0, CELL_ENTRIES), tasks: tasks.slice(0, Math.max(0, CELL_ENTRIES - events.length)) };
            const outside = monthOf(day) !== month;
            return <div key={day} role="gridcell" aria-label={formatLongDay(day)}
              className={cn('group relative flex min-h-0 flex-col gap-0.5 overflow-hidden border-b border-r p-1 [&:nth-child(7n)]:border-r-0', outside && 'bg-muted/30')}>
              <div className="flex items-center justify-between">
                <button type="button" onClick={() => setEditing({ kind: 'day', day })} aria-label={`Show ${formatLongDay(day)}`}
                  className={cn('grid size-6 place-items-center rounded-full text-xs', day === now ? 'bg-primary font-semibold text-primary-foreground' : outside ? 'text-muted-foreground' : '')}>
                  {dateAt(day).getDate()}
                </button>
                {canWrite ? <button type="button" onClick={() => setEditing({ kind: 'new', day })} aria-label={`New event on ${formatLongDay(day)}`}
                  className="grid size-6 place-items-center rounded text-muted-foreground opacity-0 hover:bg-accent focus:opacity-100 group-hover:opacity-100"><Icon name="plus" size={13} /></button> : null}
              </div>
              {shown.events.map(event => <EventChip key={event.id} event={event} day={day} onOpen={() => setEditing({ kind: 'event', event })} />)}
              {shown.tasks.map(task => <TaskChip key={task.id} task={task} onOpen={() => setEditing({ kind: 'task', task })} />)}
              {entries > CELL_ENTRIES ? <button type="button" onClick={() => setEditing({ kind: 'day', day })} className="px-1 text-left text-xs text-muted-foreground hover:underline">
                {entries - CELL_ENTRIES} more
              </button> : null}
            </div>;
          })}
        </div>)}
      </div>
    </div>

    {editing?.kind === 'new' ? <EventDialog day={editing.day} canWrite={canWrite} onClose={() => setEditing(null)} onDone={done} /> : null}
    {editing?.kind === 'event' ? <EventDialog event={editing.event} canWrite={canWrite} onClose={() => setEditing(null)} onDone={done} /> : null}
    {editing?.kind === 'task' ? <TaskDialog task={editing.task} canWrite={canWrite} onClose={() => setEditing(null)}
      onSaved={() => done()} onDeleted={() => done()} onConflict={() => done(scheduleErrorText(new ApiError(409, ''), 'task'))} /> : null}
    {editing?.kind === 'day' ? <DayDialog day={editing.day} {...entriesOn(editing.day)} canWrite={canWrite} onClose={() => setEditing(null)}
      onOpen={next => setEditing(next)} /> : null}
  </section>;
}

function EventChip({ event, day, onOpen }: { event: CalendarEvent; day: string; onOpen: () => void }) {
  const { first } = eventDays(event);
  const time = !event.allDay && first === day ? `${formatTime(event.start)} ` : '';
  return <button type="button" onClick={onOpen} title={event.title}
    className={cn('truncate rounded px-1.5 py-0.5 text-left text-xs',
      event.allDay ? 'bg-primary/15 text-foreground hover:bg-primary/25' : 'hover:bg-accent')}>
    {time ? <span className="text-muted-foreground">{time}</span> : null}{event.title}
  </button>;
}

function TaskChip({ task, onOpen }: { task: Task; onOpen: () => void }) {
  return <button type="button" onClick={onOpen} title={`Task due: ${task.title}`}
    className="flex items-center gap-1 truncate rounded px-1.5 py-0.5 text-left text-xs hover:bg-accent">
    <Icon name="check-square" size={12} className="shrink-0 text-muted-foreground" /><span className="truncate">{task.title}</span>
  </button>;
}

/** Everything on one day, when the cell has no room for it. */
function DayDialog({ day, events, tasks, canWrite, onClose, onOpen }: {
  day: string; events: CalendarEvent[]; tasks: Task[]; canWrite: boolean; onClose: () => void; onOpen: (next: Editing) => void;
}) {
  return <Dialog open onOpenChange={next => { if (!next) onClose(); }}>
    <DialogContent className="sm:max-w-sm">
      <DialogHeader><DialogTitle>{formatLongDay(day)}</DialogTitle>
        <DialogDescription>{events.length + tasks.length === 0 ? 'Nothing planned.' : `${events.length} ${events.length === 1 ? 'event' : 'events'}, ${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'} due.`}</DialogDescription></DialogHeader>
      <ul className="flex flex-col gap-1">
        {events.map(event => <li key={event.id}><button type="button" onClick={() => onOpen({ kind: 'event', event })} className="flex w-full gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent">
          <span className="w-12 shrink-0 text-muted-foreground">{event.allDay ? 'All day' : eventDays(event).first === day ? formatTime(event.start) : '…'}</span>
          <span className="min-w-0 flex-1 truncate">{event.title}</span></button></li>)}
        {tasks.map(task => <li key={task.id}><button type="button" onClick={() => onOpen({ kind: 'task', task })} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent">
          <Icon name="check-square" size={14} className="w-12 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{task.title}</span></button></li>)}
      </ul>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        {canWrite ? <Button size="sm" onClick={() => onOpen({ kind: 'new', day })}><Icon name="plus" size={15} /> New event</Button> : null}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

/** The form's fields: dates and wall times in the viewer's zone, whatever kind the event is. */
interface EventForm { title: string; allDay: boolean; startDate: string; startTime: string; endDate: string; endTime: string; location: string; notes: string }

export function formOf(event: CalendarEvent | undefined, day: string): EventForm {
  if (!event) return { title: '', allDay: false, startDate: day, startTime: '09:00', endDate: day, endTime: '10:00', location: '', notes: '' };
  if (event.allDay) return { title: event.title, allDay: true, startDate: event.start, startTime: '09:00', endDate: event.end, endTime: '10:00', location: event.location, notes: event.notes };
  const start = new Date(event.start), end = new Date(event.end);
  return { title: event.title, allDay: false, startDate: localDateOf(start), startTime: localTimeOf(start), endDate: localDateOf(end), endTime: localTimeOf(end), location: event.location, notes: event.notes };
}

/** The form as the scope stores it, or why it cannot be one. */
export function inputOf(form: EventForm): EventInput | string {
  const title = form.title.trim();
  if (!title) return 'Give the event a title.';
  if (form.allDay) {
    if (!form.startDate || !form.endDate) return 'Choose the first and last day.';
    if (form.endDate < form.startDate) return 'The last day cannot be before the first.';
    return { title, allDay: true, start: form.startDate, end: form.endDate, location: form.location.trim(), notes: form.notes, timeZone: null };
  }
  if (!form.startDate || !form.startTime || !form.endDate || !form.endTime) return 'Choose when it starts and ends.';
  const start = instantOf(form.startDate, form.startTime), end = instantOf(form.endDate, form.endTime);
  if (Date.parse(end) <= Date.parse(start)) return 'The event has to end after it starts.';
  return { title, allDay: false, start, end, location: form.location.trim(), notes: form.notes, timeZone: viewerTimeZone() };
}

function EventDialog({ event, day, canWrite, onClose, onDone }: {
  event?: CalendarEvent; day?: string; canWrite: boolean; onClose: () => void; onDone: (message?: string) => void;
}) {
  const [form, setForm] = useState(() => formOf(event, day ?? today()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof EventForm>(key: K, value: EventForm[K]) => { setForm(f => {
    const next = { ...f, [key]: value };
    // Moving the start carries the end along, so a one-hour meeting stays one hour.
    if (key === 'startDate' && f.endDate < String(value)) next.endDate = String(value);
    return next;
  }); setError(null); };
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await work(); }
    catch (e) { if (e instanceof ApiError && e.status === 409) onDone(scheduleErrorText(e, 'event')); else setError(scheduleErrorText(e, 'event')); }
    finally { setBusy(false); }
  };
  const save = () => {
    const input = inputOf(form);
    if (typeof input === 'string') { setError(input); return; }
    void run(async () => {
      if (event) await updateEvent(event.id, event.revision, input);
      else await createEvent(input);
      onDone();
    });
  };
  const remove = () => event && void run(async () => { await deleteEvent(event.id); onDone(); });
  const readOnly = busy || !canWrite;
  const field = 'block space-y-1 text-sm';
  return <Dialog open onOpenChange={next => { if (!next && !busy) onClose(); }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{event ? (canWrite ? 'Edit event' : 'Event') : 'New event'}</DialogTitle>
        <DialogDescription>{event && !event.allDay && event.timeZone && event.timeZone !== viewerTimeZone() ? `Planned in ${event.timeZone}; shown in your time.` : 'Everyone in this space sees this event.'}</DialogDescription>
      </DialogHeader>
      <form onSubmit={e => { e.preventDefault(); save(); }} className="space-y-3">
        <label className={field}><span className="font-medium">Title</span>
          <Input autoFocus value={form.title} onChange={e => set('title', e.currentTarget.value)} maxLength={500} disabled={readOnly} /></label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={form.allDay} onCheckedChange={value => set('allDay', value === true)} disabled={readOnly} aria-label="All day" /> All day
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className={field}><span className="font-medium">{form.allDay ? 'First day' : 'Starts'}</span>
            <Input type="date" value={form.startDate} onChange={e => set('startDate', e.currentTarget.value)} disabled={readOnly} aria-label="Start date" /></label>
          {form.allDay ? <span /> : <label className={field}><span className="font-medium sr-only">Start time</span>
            <Input type="time" value={form.startTime} onChange={e => set('startTime', e.currentTarget.value)} disabled={readOnly} aria-label="Start time" className="mt-6" /></label>}
          <label className={field}><span className="font-medium">{form.allDay ? 'Last day' : 'Ends'}</span>
            <Input type="date" value={form.endDate} onChange={e => set('endDate', e.currentTarget.value)} disabled={readOnly} aria-label="End date" /></label>
          {form.allDay ? <span /> : <label className={field}><span className="font-medium sr-only">End time</span>
            <Input type="time" value={form.endTime} onChange={e => set('endTime', e.currentTarget.value)} disabled={readOnly} aria-label="End time" className="mt-6" /></label>}
        </div>
        <label className={field}><span className="font-medium">Location</span>
          <Input value={form.location} onChange={e => set('location', e.currentTarget.value)} maxLength={500} disabled={readOnly} /></label>
        <label className={field}><span className="font-medium">Notes</span>
          <textarea value={form.notes} onChange={e => set('notes', e.currentTarget.value)} maxLength={10_000} rows={3} disabled={readOnly}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50" /></label>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter className="gap-2 sm:justify-between">
          {event && canWrite ? <Button type="button" variant="outline" size="sm" disabled={busy} onClick={remove}><Icon name="trash" size={14} /> Delete</Button> : <span />}
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onClose}>{canWrite ? 'Cancel' : 'Close'}</Button>
            {canWrite ? <Button type="submit" size="sm" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button> : null}
          </div>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
