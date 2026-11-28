import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CalendarView, formOf, inputOf } from './calendar-view';
import type { CalendarEvent, Task } from './api';
import { instantOf, localTimeOf } from './schedule-dates';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const stamps = { createdAt: '2026-11-01T00:00:00Z', createdBy: 'p1', updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'p1', revision: 1 };
const event = (over: Partial<CalendarEvent> & { id: string; title: string }): CalendarEvent => ({
  notes: '', location: '', allDay: true, start: '2026-12-10', end: '2026-12-10', timeZone: null, ...stamps, ...over,
});
const task: Task = { id: 't1', title: 'Pay invoice', notes: '', status: 'needs-action', due: '2026-12-15', completedAt: null, completedBy: null, ...stamps };

function mockApi(events: CalendarEvent[], tasks: Task[], canWrite = true) {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return new Response(JSON.stringify(event({ id: 'new', title: 'x' })));
    return new Response(JSON.stringify({ events, tasks, canWrite }));
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('the calendar view', () => {
  it('reads the six weeks on screen and shows events and tasks due on their days', async () => {
    const fetch = mockApi([
      event({ id: 'e1', title: 'Trip to Lund', start: '2026-12-10', end: '2026-12-12' }),
      event({ id: 'e2', title: 'Call with Acme', allDay: false, start: instantOf('2026-12-10', '09:00'), end: instantOf('2026-12-10', '09:30') }),
    ], [task]);
    render(<CalendarView initialMonth="2026-12-01" />);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/calendar?from=2026-11-30&to=2027-01-11', expect.anything()));

    const cells = await screen.findAllByRole('gridcell');
    expect(cells).toHaveLength(42);
    const tenth = cells[10]!, twelfth = cells[12]!, fifteenth = cells[15]!;
    expect(await within(tenth).findByText('Trip to Lund')).toBeTruthy();
    expect(within(tenth).getByText('Call with Acme')).toBeTruthy();
    expect(within(tenth).getByText('09:00')).toBeTruthy();
    // A three-day trip is on each of its days.
    expect(within(twelfth).getByText('Trip to Lund')).toBeTruthy();
    expect(within(fifteenth).getByText('Pay invoice')).toBeTruthy();
  });

  it('creates a timed event in the viewer’s time', async () => {
    const fetch = mockApi([], []);
    render(<CalendarView initialMonth="2026-12-01" />);
    fireEvent.click(await screen.findByRole('button', { name: 'New event' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Dinner' } });
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-12-05' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-12-05' } });
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '19:00' } });
    fireEvent.change(screen.getByLabelText('End time'), { target: { value: '21:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/events', expect.objectContaining({ method: 'POST' })));
    const body = JSON.parse(fetch.mock.calls.find(([url, init]) => url === '/api/events' && init?.method === 'POST')![1]!.body as string);
    expect(body).toMatchObject({ title: 'Dinner', allDay: false, start: instantOf('2026-12-05', '19:00'), end: instantOf('2026-12-05', '21:00') });
  });

  it('offers no way to add an event to someone who can only read the space', async () => {
    mockApi([event({ id: 'e1', title: 'Trip' })], []);
    cleanup();
    mockApi([event({ id: 'e1', title: 'Trip' })], [], false);
    render(<CalendarView initialMonth="2026-12-01" />);
    expect(await screen.findAllByText('Trip')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New event' })).toBeNull();
  });
});

describe('the event form', () => {
  it('refuses a span that ends before it starts', () => {
    const form = formOf(undefined, '2026-12-05');
    expect(inputOf({ ...form, title: '' })).toBe('Give the event a title.');
    expect(inputOf({ ...form, title: 'x', startTime: '10:00', endTime: '09:00' })).toBe('The event has to end after it starts.');
    expect(inputOf({ ...form, title: 'x', allDay: true, startDate: '2026-12-06', endDate: '2026-12-05' })).toBe('The last day cannot be before the first.');
    expect(inputOf({ ...form, title: 'x', allDay: true })).toMatchObject({ allDay: true, start: '2026-12-05', end: '2026-12-05', timeZone: null });
  });

  it('opens a timed event at its local times', () => {
    const start = instantOf('2026-12-05', '19:00'), end = instantOf('2026-12-05', '21:30');
    const form = formOf(event({ id: 'e', title: 'Dinner', allDay: false, start, end }), '2026-12-01');
    expect(form).toMatchObject({ allDay: false, startDate: '2026-12-05', startTime: localTimeOf(new Date(start)), endTime: '21:30' });
  });
});
