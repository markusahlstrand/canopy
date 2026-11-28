import { describe, expect, it } from 'vitest';
import { addDays, addMonths, dueLabel, eventDays, instantOf, localDateOf, localTimeOf, monthGrid, touches } from './schedule-dates';

describe('schedule dates', () => {
  it('lays a month out in six Monday-first weeks', () => {
    const december = monthGrid('2026-12-15');
    expect(december).toHaveLength(42);
    // 1 December 2026 is a Tuesday: the grid opens on the Monday before it.
    expect(december[0]).toBe('2026-11-30');
    expect(december[1]).toBe('2026-12-01');
    expect(december.at(-1)).toBe('2027-01-10');
    // A month that starts on a Monday starts the grid itself.
    expect(monthGrid('2027-02-01')[0]).toBe('2027-02-01');
  });

  it('steps days and months across their edges', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addMonths('2026-12-01', 1)).toBe('2027-01-01');
    expect(addMonths('2026-01-01', -1)).toBe('2025-12-01');
  });

  it('turns a local date and time into the instant stored, and back', () => {
    const instant = instantOf('2026-12-10', '09:30');
    expect(instant).toMatch(/Z$/);
    expect(localDateOf(new Date(instant))).toBe('2026-12-10');
    expect(localTimeOf(new Date(instant))).toBe('09:30');
  });

  it('places an event on the local days it touches', () => {
    expect(eventDays({ allDay: true, start: '2026-12-10', end: '2026-12-12' })).toEqual({ first: '2026-12-10', last: '2026-12-12' });
    const dinner = { allDay: false, start: instantOf('2026-12-10', '20:00'), end: instantOf('2026-12-11', '01:00') };
    expect(touches(dinner, '2026-12-10')).toBe(true);
    expect(touches(dinner, '2026-12-11')).toBe(true);
    // Ending at midnight is not being on the next day.
    const evening = { allDay: false, start: instantOf('2026-12-10', '20:00'), end: instantOf('2026-12-11', '00:00') };
    expect(touches(evening, '2026-12-11')).toBe(false);
  });

  it('names near due dates and flags the ones that passed', () => {
    expect(dueLabel('2026-12-10', '2026-12-10')).toEqual({ text: 'Today', overdue: false });
    expect(dueLabel('2026-12-11', '2026-12-10')).toEqual({ text: 'Tomorrow', overdue: false });
    expect(dueLabel('2026-12-09', '2026-12-10')).toEqual({ text: 'Yesterday', overdue: true });
    expect(dueLabel('2026-12-01', '2026-12-10').overdue).toBe(true);
    expect(dueLabel('2026-12-20', '2026-12-10').overdue).toBe(false);
  });
});
