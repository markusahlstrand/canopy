/**
 * A space's tasks and calendar: what is to be done, and what happens when.
 *
 * Shaped after JSCalendar (RFC 8984) so an iCal/CalDAV export later is a projection, not a
 * redesign: a task's `status` is JSCalendar's `progress` vocabulary, an event is all-day
 * (`showWithoutTime`) or timed, and a timed event remembers the zone it was planned in.
 *
 * Two ways a calendar entry is written, never mixed in one row:
 *
 *  - **All-day:** `start` and `end` are local dates (`YYYY-MM-DD`) and `end` is the LAST day,
 *    inclusive — a one-day event has `start === end`. A birthday is on a date, not at an instant,
 *    so it stays on that date whoever looks at it from wherever.
 *  - **Timed:** `start` and `end` are UTC instants (`…Z`), `end` exclusive, and `timeZone` is the
 *    IANA zone it was planned in, for showing and exporting it the way it was meant.
 *
 * A task's `due` is a local date. A task is not copied into the calendar to show on that date:
 * the calendar reads tasks by their due date, so moving one moves it everywhere.
 *
 * Not here yet, on purpose: recurrence, participants and resources (each its own slice), and
 * links between tasks, events, files and people — those go through the space's graph.
 */
import { z } from '@substrat-run/contracts';

/** JSCalendar's `progress` for a task. A checkbox reads `completed` as ticked, everything else as open. */
export const TASK_STATUSES = ['needs-action', 'in-process', 'completed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['needs-action', 'in-process'];

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;

/** A calendar date that exists: `2026-02-30` is a typo, not a day. */
export function isLocalDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** A UTC instant written the one way rows store it. */
export function isInstant(value: string): boolean {
  return INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

/** The longest an event may last: past a year it is a season, not an entry. */
export const MAX_EVENT_DAYS = 366;
/** The widest window one calendar read covers: a month grid with its edges, and then some. */
export const MAX_CALENDAR_WINDOW_DAYS = 100;

const DAY_MS = 86_400_000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;

/** Days from `from` to `to`, both local dates. */
export const daysBetween = (from: string, to: string) => dayNumber(to) - dayNumber(from);

/** `date` moved by `days`, still a local date. */
export function addDays(date: string, days: number): string {
  return new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Why an event's times are not a span, or null when they are. One rule for create and update,
 * so an update that changes only `end` is held to what a create would have been.
 */
export function eventTimesProblem(allDay: boolean, start: string, end: string): string | null {
  if (allDay) {
    if (!isLocalDate(start) || !isLocalDate(end)) return 'an all-day event starts and ends on dates (YYYY-MM-DD)';
    const days = daysBetween(start, end);
    if (days < 0) return 'an event cannot end before it starts';
    if (days + 1 > MAX_EVENT_DAYS) return `an event lasts at most ${MAX_EVENT_DAYS} days`;
    return null;
  }
  if (!isInstant(start) || !isInstant(end)) return 'a timed event starts and ends at UTC instants (…Z)';
  const ms = Date.parse(end) - Date.parse(start);
  if (ms <= 0) return 'an event must end after it starts';
  if (ms > MAX_EVENT_DAYS * DAY_MS) return `an event lasts at most ${MAX_EVENT_DAYS} days`;
  return null;
}

/** An IANA zone name as the browser reports it (`Europe/Madrid`, `UTC`). Checked for shape, not membership. */
export const timeZoneName = z.string().regex(/^[A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+){0,2}$/).max(64);

export const localDate = z.string().refine(isLocalDate, { message: 'a date, as YYYY-MM-DD' });

const title = z.string().trim().min(1).max(500);
const notes = z.string().max(10_000);
const location = z.string().trim().max(500);

export const task = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string(),
  status: z.enum(TASK_STATUSES),
  due: z.string().nullable(),
  createdAt: z.string(), createdBy: z.string(),
  updatedAt: z.string(), updatedBy: z.string(),
  completedAt: z.string().nullable(), completedBy: z.string().nullable(),
  /** Bumped on every change; an update names the one it read, so two edits cannot silently cross. */
  revision: z.number().int(),
});
export type Task = z.infer<typeof task>;

export const calendarEvent = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string(),
  location: z.string(),
  allDay: z.boolean(),
  start: z.string(),
  end: z.string(),
  timeZone: z.string().nullable(),
  createdAt: z.string(), createdBy: z.string(),
  updatedAt: z.string(), updatedBy: z.string(),
  revision: z.number().int(),
});
export type CalendarEvent = z.infer<typeof calendarEvent>;

export const createTaskInput = z.object({
  title, notes: notes.optional(), due: localDate.nullable().optional(), status: z.enum(TASK_STATUSES).optional(),
});
export const updateTaskInput = z.object({
  taskId: z.string(), revision: z.number().int(),
  title: title.optional(), notes: notes.optional(), due: localDate.nullable().optional(), status: z.enum(TASK_STATUSES).optional(),
});

const eventFields = {
  title, notes: notes.optional(), location: location.optional(),
  allDay: z.boolean(), start: z.string().max(40), end: z.string().max(40),
  timeZone: timeZoneName.nullable().optional(),
};
export const createEventInput = z.object(eventFields).superRefine((value, ctx) => {
  const problem = eventTimesProblem(value.allDay, value.start, value.end);
  if (problem) ctx.addIssue({ code: 'custom', path: ['end'], message: problem });
});
/** Times are checked against the row they land on: an update may move only one end. */
export const updateEventInput = z.object({
  eventId: z.string(), revision: z.number().int(),
  title: title.optional(), notes: notes.optional(), location: location.optional(),
  allDay: z.boolean().optional(), start: z.string().max(40).optional(), end: z.string().max(40).optional(),
  timeZone: timeZoneName.nullable().optional(),
});

/** A calendar read: local dates, `to` exclusive. */
export const calendarWindow = z.object({ from: localDate, to: localDate }).superRefine((value, ctx) => {
  const days = daysBetween(value.from, value.to);
  if (days <= 0) ctx.addIssue({ code: 'custom', path: ['to'], message: 'the window ends after it starts' });
  else if (days > MAX_CALENDAR_WINDOW_DAYS) ctx.addIssue({ code: 'custom', path: ['to'], message: `a window covers at most ${MAX_CALENDAR_WINDOW_DAYS} days` });
});
