/**
 * Dates as the Tasks and Calendar views read them: in the viewer's own zone.
 *
 * The scope stores all-day events and due dates as local dates (`YYYY-MM-DD`) and timed events
 * as UTC instants (`spec/scheduling.ts`). This is the one place that turns one into the other,
 * so a view never does its own arithmetic on `Date`.
 */
import type { CalendarEvent } from './api';

const pad = (n: number) => String(n).padStart(2, '0');

/** A `Date`'s local calendar day. */
export const localDateOf = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
/** A `Date`'s local wall time, `HH:mm`. */
export const localTimeOf = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
export const today = (now = new Date()) => localDateOf(now);

/** Local midnight of a local date, as a `Date`. */
export function dateAt(date: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}
export function addDays(date: string, days: number): string {
  const at = dateAt(date);
  at.setDate(at.getDate() + days);
  return localDateOf(at);
}

/** A local date and wall time as the UTC instant the scope stores. */
export function instantOf(date: string, time: string): string {
  const [h, min] = time.split(':').map(Number) as [number, number];
  const at = dateAt(date);
  at.setHours(h, min, 0, 0);
  return at.toISOString();
}

/** The viewer's IANA zone, for a timed event planned now. */
export const viewerTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || null;

/** The first of a month, from any date in it. */
export const monthOf = (date: string) => `${date.slice(0, 7)}-01`;
export function addMonths(month: string, months: number): string {
  const at = dateAt(month);
  at.setDate(1);
  at.setMonth(at.getMonth() + months);
  return localDateOf(at);
}

/**
 * The six weeks a month grid shows, Monday first — the week as it is read in Spain and Sweden.
 * Six rows always, so the grid does not jump in height between months.
 */
export function monthGrid(month: string): string[] {
  const first = dateAt(monthOf(month));
  const back = (first.getDay() + 6) % 7;
  const start = addDays(localDateOf(first), -back);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** The local days an event touches: all of them for a trip, the one (or two) a late dinner spans. */
export function eventDays(event: Pick<CalendarEvent, 'allDay' | 'start' | 'end'>): { first: string; last: string } {
  if (event.allDay) return { first: event.start, last: event.end };
  const start = new Date(event.start), end = new Date(Date.parse(event.end) - 1);
  return { first: localDateOf(start), last: localDateOf(end < start ? start : end) };
}
export function touches(event: Pick<CalendarEvent, 'allDay' | 'start' | 'end'>, day: string): boolean {
  const { first, last } = eventDays(event);
  return first <= day && day <= last;
}

const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const dayFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const longDayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const monthFormat = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });

/** Mon … Sun, in the viewer's language. */
export const weekdayNames = () => monthGrid('2026-06-01').slice(0, 7).map(day => weekdayFormat.format(dateAt(day)));
export const formatMonth = (month: string) => monthFormat.format(dateAt(month));
export const formatDay = (date: string) => dayFormat.format(dateAt(date));
export const formatLongDay = (date: string) => longDayFormat.format(dateAt(date));
export const formatTime = (instant: string) => localTimeOf(new Date(instant));

/** How a due date reads on a list: near ones by name, overdue ones flagged. */
export function dueLabel(due: string, now = today()): { text: string; overdue: boolean } {
  if (due === now) return { text: 'Today', overdue: false };
  if (due === addDays(now, 1)) return { text: 'Tomorrow', overdue: false };
  if (due === addDays(now, -1)) return { text: 'Yesterday', overdue: true };
  return { text: formatDay(due), overdue: due < now };
}
