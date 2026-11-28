/**
 * A space's tasks and calendar (`spec/scheduling.ts` for the shapes, migration 0021 for the tables).
 *
 * Rules that keep a shared list honest:
 *
 *  - **Space-wide.** Reading the space reads its tasks and events; writing the space writes them.
 *    There is no per-task grant: a household list is the household's, and a folder share does not
 *    reach it.
 *  - **No silent crossing.** Every change names the `revision` it read; if someone changed the
 *    row since, the change is refused as a conflict and the caller reads it again.
 *  - **Who and when stay true.** Ticking a task off records who did it and when; opening it again
 *    clears both, so the row never claims a completion that was undone.
 *  - **One rule for times.** An update is checked as the row it would leave behind, so moving one
 *    end of an event cannot produce a span a create would have refused.
 */
import { substratError, type HandlerInput, type HandlerOutput } from '@substrat-run/contracts';
import { assertAllowed, ulid, type OperationContext, type OperationHandler } from '@substrat-run/kernel';
import { DRIVE_PERM } from './manifest.js';
import {
  addDays, eventTimesProblem, OPEN_TASK_STATUSES,
  type CalendarEvent, type driveOperations, type Task, type TaskStatus,
} from '../spec/model.js';

type TaskRow = {
  id: string; title: string; notes: string; status: TaskStatus; due: string | null;
  created_at: string; created_by: string; updated_at: string; updated_by: string;
  completed_at: string | null; completed_by: string | null; revision: number; deleted_at: string | null;
};
type EventRow = {
  id: string; title: string; notes: string; location: string; all_day: number; start: string; end: string; time_zone: string | null;
  created_at: string; created_by: string; updated_at: string; updated_by: string; revision: number; deleted_at: string | null;
};

const taskOf = (r: TaskRow): Task => ({
  id: r.id, title: r.title, notes: r.notes, status: r.status, due: r.due,
  createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at, updatedBy: r.updated_by,
  completedAt: r.completed_at, completedBy: r.completed_by, revision: r.revision,
});
const eventOf = (r: EventRow): CalendarEvent => ({
  id: r.id, title: r.title, notes: r.notes, location: r.location, allDay: r.all_day === 1, start: r.start, end: r.end,
  timeZone: r.time_zone, createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at, updatedBy: r.updated_by,
  revision: r.revision,
});

/** How many open tasks one read returns, and how many finished ones `show: 'all'` adds. */
const OPEN_LIMIT = 500;
const DONE_LIMIT = 100;
/** How many events one calendar window returns: a busy month, several times over. */
const EVENT_LIMIT = 1000;

const OPEN_IN = `status IN (${OPEN_TASK_STATUSES.map(() => '?').join(', ')})`;
/** Open first by date, undated after; the order a to-do list is read in. */
const OPEN_ORDER = 'ORDER BY due IS NULL, due, created_at, id';

const canWrite = async (ctx: OperationContext) => (await ctx.check(DRIVE_PERM.write)).allowed;

function liveTask(ctx: OperationContext, id: string): TaskRow {
  const row = ctx.sql.query<TaskRow>('SELECT * FROM drive_tasks WHERE id = ? AND deleted_at IS NULL', [id])[0];
  if (!row) throw substratError('not_found', `task not found: ${id}`);
  return row;
}
function liveEvent(ctx: OperationContext, id: string): EventRow {
  const row = ctx.sql.query<EventRow>('SELECT * FROM drive_events WHERE id = ? AND deleted_at IS NULL', [id])[0];
  if (!row) throw substratError('not_found', `event not found: ${id}`);
  return row;
}
function sameRevision(found: number, read: number, what: string): void {
  if (found !== read) throw substratError('conflict', `${what} changed since it was read — read it again`);
}

/** Completion follows status: who ticked it and when, kept only while it stays ticked. */
function completion(ctx: OperationContext, status: TaskStatus, before?: TaskRow): { completed_at: string | null; completed_by: string | null } {
  if (status !== 'completed') return { completed_at: null, completed_by: null };
  if (before?.status === 'completed') return { completed_at: before.completed_at, completed_by: before.completed_by };
  return { completed_at: ctx.now(), completed_by: ctx.principal };
}

type Ops = typeof driveOperations;
type SchedulingOp = 'drive/list-tasks' | 'drive/create-task' | 'drive/update-task' | 'drive/delete-task'
  | 'drive/calendar' | 'drive/create-event' | 'drive/update-event' | 'drive/delete-event';

export const schedulingHandlers = {
  'drive/list-tasks': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.read));
    const open = ctx.sql.query<TaskRow>(
      `SELECT * FROM drive_tasks WHERE deleted_at IS NULL AND ${OPEN_IN} ${OPEN_ORDER} LIMIT ?`,
      [...OPEN_TASK_STATUSES, OPEN_LIMIT],
    );
    const done = input.show === 'all'
      ? ctx.sql.query<TaskRow>(
        `SELECT * FROM drive_tasks WHERE deleted_at IS NULL AND NOT ${OPEN_IN} ORDER BY COALESCE(completed_at, updated_at) DESC, id DESC LIMIT ?`,
        [...OPEN_TASK_STATUSES, DONE_LIMIT],
      )
      : [];
    return { tasks: [...open, ...done].map(taskOf), canWrite: await canWrite(ctx) };
  },

  'drive/create-task': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.write));
    const now = ctx.now();
    const status = input.status ?? 'needs-action';
    const row: TaskRow = {
      id: ulid(), title: input.title, notes: input.notes ?? '', status, due: input.due ?? null,
      created_at: now, created_by: ctx.principal, updated_at: now, updated_by: ctx.principal,
      ...completion(ctx, status), revision: 1, deleted_at: null,
    };
    ctx.sql.exec(
      `INSERT INTO drive_tasks (id, title, notes, status, due, created_at, created_by, updated_at, updated_by, completed_at, completed_by, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.title, row.notes, row.status, row.due, row.created_at, row.created_by, row.updated_at, row.updated_by, row.completed_at, row.completed_by, row.revision],
    );
    return taskOf(row);
  },

  'drive/update-task': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.write));
    const before = liveTask(ctx, input.taskId);
    sameRevision(before.revision, input.revision, 'this task');
    const status = input.status ?? before.status;
    const row: TaskRow = {
      ...before,
      title: input.title ?? before.title,
      notes: input.notes ?? before.notes,
      due: input.due === undefined ? before.due : input.due,
      status, ...completion(ctx, status, before),
      updated_at: ctx.now(), updated_by: ctx.principal, revision: before.revision + 1,
    };
    ctx.sql.exec(
      `UPDATE drive_tasks SET title = ?, notes = ?, due = ?, status = ?, completed_at = ?, completed_by = ?, updated_at = ?, updated_by = ?, revision = ?
       WHERE id = ? AND revision = ?`,
      [row.title, row.notes, row.due, row.status, row.completed_at, row.completed_by, row.updated_at, row.updated_by, row.revision, row.id, before.revision],
    );
    return taskOf(row);
  },

  'drive/delete-task': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.write));
    const row = liveTask(ctx, input.taskId);
    ctx.sql.exec('UPDATE drive_tasks SET deleted_at = ?, updated_at = ?, updated_by = ?, revision = revision + 1 WHERE id = ?',
      [ctx.now(), ctx.now(), ctx.principal, row.id]);
    return { ok: true as const };
  },

  'drive/calendar': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.read));
    // All-day rows are local dates with an inclusive end: they overlap [from, to) when they
    // start before `to` and end on or after `from`.
    const allDay = ctx.sql.query<EventRow>(
      `SELECT * FROM drive_events WHERE deleted_at IS NULL AND all_day = 1 AND start < ? AND "end" >= ? ORDER BY start, id LIMIT ?`,
      [input.to, input.from, EVENT_LIMIT],
    );
    // Timed rows are UTC instants: a local day can begin up to 14 hours either side of UTC
    // midnight, so the window is read a day wider each way and the client places each event.
    const timed = ctx.sql.query<EventRow>(
      `SELECT * FROM drive_events WHERE deleted_at IS NULL AND all_day = 0 AND start < ? AND "end" > ? ORDER BY start, id LIMIT ?`,
      [`${addDays(input.to, 1)}T00:00:00.000Z`, `${addDays(input.from, -1)}T00:00:00.000Z`, EVENT_LIMIT],
    );
    const tasks = ctx.sql.query<TaskRow>(
      `SELECT * FROM drive_tasks WHERE deleted_at IS NULL AND ${OPEN_IN} AND due >= ? AND due < ? ${OPEN_ORDER} LIMIT ?`,
      [...OPEN_TASK_STATUSES, input.from, input.to, OPEN_LIMIT],
    );
    return {
      events: [...allDay, ...timed].map(eventOf).sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id)),
      tasks: tasks.map(taskOf),
      canWrite: await canWrite(ctx),
    };
  },

  'drive/create-event': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.write));
    const now = ctx.now();
    const row: EventRow = {
      id: ulid(), title: input.title, notes: input.notes ?? '', location: input.location ?? '',
      all_day: input.allDay ? 1 : 0, start: input.start, end: input.end,
      // A zone means "planned at this local time"; an all-day event is on a date, not in a zone.
      time_zone: input.allDay ? null : input.timeZone ?? null,
      created_at: now, created_by: ctx.principal, updated_at: now, updated_by: ctx.principal, revision: 1, deleted_at: null,
    };
    ctx.sql.exec(
      `INSERT INTO drive_events (id, title, notes, location, all_day, start, "end", time_zone, created_at, created_by, updated_at, updated_by, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.title, row.notes, row.location, row.all_day, row.start, row.end, row.time_zone, row.created_at, row.created_by, row.updated_at, row.updated_by, row.revision],
    );
    return eventOf(row);
  },

  'drive/update-event': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.write));
    const before = liveEvent(ctx, input.eventId);
    sameRevision(before.revision, input.revision, 'this event');
    const allDay = input.allDay ?? before.all_day === 1;
    const start = input.start ?? before.start, end = input.end ?? before.end;
    const problem = eventTimesProblem(allDay, start, end);
    if (problem) throw substratError('validation_failed', problem);
    const row: EventRow = {
      ...before,
      title: input.title ?? before.title,
      notes: input.notes ?? before.notes,
      location: input.location ?? before.location,
      all_day: allDay ? 1 : 0, start, end,
      time_zone: allDay ? null : input.timeZone === undefined ? before.time_zone : input.timeZone,
      updated_at: ctx.now(), updated_by: ctx.principal, revision: before.revision + 1,
    };
    ctx.sql.exec(
      `UPDATE drive_events SET title = ?, notes = ?, location = ?, all_day = ?, start = ?, "end" = ?, time_zone = ?, updated_at = ?, updated_by = ?, revision = ?
       WHERE id = ? AND revision = ?`,
      [row.title, row.notes, row.location, row.all_day, row.start, row.end, row.time_zone, row.updated_at, row.updated_by, row.revision, row.id, before.revision],
    );
    return eventOf(row);
  },

  'drive/delete-event': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.write));
    const row = liveEvent(ctx, input.eventId);
    ctx.sql.exec('UPDATE drive_events SET deleted_at = ?, updated_at = ?, updated_by = ?, revision = revision + 1 WHERE id = ?',
      [ctx.now(), ctx.now(), ctx.principal, row.id]);
    return { ok: true as const };
  },
} satisfies {
  [K in SchedulingOp]: OperationHandler<HandlerInput<Ops[K]>, HandlerOutput<Ops[K]>>;
};
