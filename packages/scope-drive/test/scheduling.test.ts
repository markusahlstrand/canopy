import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { driveManifest, driveModule, DRIVE_PERM, ROOT_FOLDER_ID } from '../src/index.js';
import { ROLES } from '../src/provision.js';
import { eventTimesProblem, type CalendarEvent, type Task } from '../spec/model.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function world() {
  const dir = mkdtempSync(join(tmpdir(), 'scheduling-')); dirs.push(dir);
  const host = new SqliteScopeHost({ dir }); host.registerModule(driveModule);
  const staff = platformActorId.parse(ulid()), t = tenantId.parse(ulid()), s = scopeId.parse(ulid());
  await host.admin.createTenant(staff, { id: t, slug: 'home', name: 'Home' });
  await host.admin.grantEntitlement(staff, t, driveManifest.entitlementKey as string);
  await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'drive' });
  await host.admin.activateScope(staff, t, s);
  for (const role of ROLES) await host.admin.defineRole(staff, t, role);
  const as = async (roleKey: string) => {
    const who = principalId.parse(ulid());
    await host.admin.assignRole(staff, { principalId: who, roleKey, node: { tenantId: t, scopeId: s } });
    return { id: who, scope: await host.getScope(who, t, s) };
  };
  const owner = await as('owner'), editor = await as('editor'), member = await as('member');
  // Writes one folder and nothing else: a share does not reach the space's list.
  const folder = await owner.scope.invoke<{ id: string }>('drive/create-folder', { parentId: ROOT_FOLDER_ID, name: 'Shared' });
  const narrowId = principalId.parse(ulid());
  for (const permission of [DRIVE_PERM.read, DRIVE_PERM.write]) {
    await host.admin.grant(staff, { principalId: narrowId, permission, node: { tenantId: t, scopeId: s },
      entity: { entityType: 'folder', entityId: folder.id }, grantedBy: owner.id });
  }
  const narrow = { id: narrowId, scope: await host.getScope(narrowId, t, s) };
  return { owner, editor, member, narrow };
}

type Scope = Awaited<ReturnType<typeof world>>['owner']['scope'];
const createTask = (scope: Scope, input: Record<string, unknown>) => scope.invoke<Task>('drive/create-task', input);
const listTasks = (scope: Scope, show?: 'open' | 'all') =>
  scope.invoke<{ tasks: Task[]; canWrite: boolean }>('drive/list-tasks', show ? { show } : {});
const createEvent = (scope: Scope, input: Record<string, unknown>) => scope.invoke<CalendarEvent>('drive/create-event', input);
const calendar = (scope: Scope, from: string, to: string) =>
  scope.invoke<{ events: CalendarEvent[]; tasks: Task[]; canWrite: boolean }>('drive/calendar', { from, to });

describe('tasks', () => {
  it('lists open tasks soonest due first, undated last, and finished ones only when asked', async () => {
    const w = await world();
    await createTask(w.owner.scope, { title: 'Someday' });
    await createTask(w.owner.scope, { title: 'Later', due: '2026-12-20' });
    await createTask(w.owner.scope, { title: 'Soon', due: '2026-12-01' });
    const done = await createTask(w.owner.scope, { title: 'Done already', status: 'completed' });
    expect(done).toMatchObject({ status: 'completed', completedBy: w.owner.id });
    expect(done.completedAt).not.toBeNull();

    expect((await listTasks(w.owner.scope)).tasks.map(task => task.title)).toEqual(['Soon', 'Later', 'Someday']);
    expect((await listTasks(w.owner.scope, 'all')).tasks.map(task => task.title)).toEqual(['Soon', 'Later', 'Someday', 'Done already']);
  });

  it('records who ticked a task off, and forgets it when the task is opened again', async () => {
    const w = await world();
    const task = await createTask(w.owner.scope, { title: 'Buy milk' });
    expect(task).toMatchObject({ status: 'needs-action', completedAt: null, completedBy: null, revision: 1, createdBy: w.owner.id });

    const ticked = await w.editor.scope.invoke<Task>('drive/update-task', { taskId: task.id, revision: 1, status: 'completed' });
    expect(ticked).toMatchObject({ status: 'completed', completedBy: w.editor.id, updatedBy: w.editor.id, revision: 2 });
    // A later edit of a finished task keeps who finished it.
    const renamed = await w.owner.scope.invoke<Task>('drive/update-task', { taskId: task.id, revision: 2, title: 'Buy oat milk' });
    expect(renamed).toMatchObject({ title: 'Buy oat milk', completedBy: w.editor.id, completedAt: ticked.completedAt, revision: 3 });

    const reopened = await w.owner.scope.invoke<Task>('drive/update-task', { taskId: task.id, revision: 3, status: 'needs-action' });
    expect(reopened).toMatchObject({ status: 'needs-action', completedAt: null, completedBy: null });
  });

  it('refuses a change made against a revision someone else already moved past', async () => {
    const w = await world();
    const task = await createTask(w.owner.scope, { title: 'Book dentist', due: '2026-12-03' });
    await w.editor.scope.invoke('drive/update-task', { taskId: task.id, revision: 1, due: '2026-12-04' });
    await expect(w.owner.scope.invoke('drive/update-task', { taskId: task.id, revision: 1, title: 'Book the dentist' }))
      .rejects.toThrow('changed since it was read');
    // Clearing a date is a change, not an absence.
    const cleared = await w.owner.scope.invoke<Task>('drive/update-task', { taskId: task.id, revision: 2, due: null });
    expect(cleared.due).toBeNull();
  });

  it('removes a task from every read, and refuses to touch it after', async () => {
    const w = await world();
    const task = await createTask(w.owner.scope, { title: 'Gone', due: '2026-12-02' });
    await w.owner.scope.invoke('drive/delete-task', { taskId: task.id });
    expect((await listTasks(w.owner.scope, 'all')).tasks).toEqual([]);
    expect((await calendar(w.owner.scope, '2026-12-01', '2026-12-31')).tasks).toEqual([]);
    await expect(w.owner.scope.invoke('drive/update-task', { taskId: task.id, revision: 2, title: 'Back' })).rejects.toThrow('task not found');
    await expect(w.owner.scope.invoke('drive/delete-task', { taskId: task.id })).rejects.toThrow('task not found');
  });

  it('lets a member read the list but not write it, and a folder share reaches neither', async () => {
    const w = await world();
    const task = await createTask(w.owner.scope, { title: 'Water plants' });
    const read = await listTasks(w.member.scope);
    expect(read.tasks.map(t => t.title)).toEqual(['Water plants']);
    expect(read.canWrite).toBe(false);
    expect((await listTasks(w.editor.scope)).canWrite).toBe(true);

    await expect(createTask(w.member.scope, { title: 'Nope' })).rejects.toThrow();
    await expect(w.member.scope.invoke('drive/update-task', { taskId: task.id, revision: 1, status: 'completed' })).rejects.toThrow();
    await expect(w.member.scope.invoke('drive/delete-task', { taskId: task.id })).rejects.toThrow();

    await expect(listTasks(w.narrow.scope)).rejects.toThrow();
    await expect(createTask(w.narrow.scope, { title: 'Nope' })).rejects.toThrow();
  });

  it('refuses an empty title and a date that does not exist', async () => {
    const w = await world();
    for (const input of [{ title: '  ' }, { title: 'x'.repeat(501) }, { title: 'Bad date', due: '2026-02-30' }, { title: 'Bad date', due: '1 Dec' }]) {
      await expect(createTask(w.owner.scope, input)).rejects.toThrow();
    }
  });
});

describe('calendar events', () => {
  it('stores all-day events on dates and timed ones between instants, with their zone', async () => {
    const w = await world();
    const trip = await createEvent(w.owner.scope, { title: 'Trip', allDay: true, start: '2026-12-10', end: '2026-12-12', timeZone: 'Europe/Madrid' });
    expect(trip).toMatchObject({ allDay: true, start: '2026-12-10', end: '2026-12-12', timeZone: null, revision: 1, createdBy: w.owner.id });
    const call = await createEvent(w.editor.scope, {
      title: 'Call with Acme', location: 'Zoom', allDay: false,
      start: '2026-12-10T09:00:00.000Z', end: '2026-12-10T09:30:00.000Z', timeZone: 'Europe/Madrid',
    });
    expect(call).toMatchObject({ allDay: false, timeZone: 'Europe/Madrid', location: 'Zoom', createdBy: w.editor.id });
  });

  it('shows what overlaps the window, with the open tasks due in it', async () => {
    const w = await world();
    await createEvent(w.owner.scope, { title: 'Ends on the first', allDay: true, start: '2026-11-28', end: '2026-12-01' });
    await createEvent(w.owner.scope, { title: 'Before', allDay: true, start: '2026-11-20', end: '2026-11-30' });
    await createEvent(w.owner.scope, { title: 'Starts on the last', allDay: true, start: '2026-12-31', end: '2026-12-31' });
    await createEvent(w.owner.scope, { title: 'After', allDay: true, start: '2027-01-01', end: '2027-01-01' });
    await createEvent(w.owner.scope, { title: 'Late on the 30th, UTC', allDay: false, start: '2026-11-30T23:30:00.000Z', end: '2026-12-01T00:30:00.000Z' });
    await createEvent(w.owner.scope, { title: 'Long gone', allDay: false, start: '2026-11-01T10:00:00.000Z', end: '2026-11-01T11:00:00.000Z' });
    await createTask(w.owner.scope, { title: 'Pay invoice', due: '2026-12-15' });
    await createTask(w.owner.scope, { title: 'Paid', due: '2026-12-16', status: 'completed' });
    await createTask(w.owner.scope, { title: 'No date' });
    await createTask(w.owner.scope, { title: 'Next year', due: '2027-01-01' });

    const read = await calendar(w.member.scope, '2026-12-01', '2027-01-01');
    expect(read.events.map(e => e.title)).toEqual(['Ends on the first', 'Late on the 30th, UTC', 'Starts on the last']);
    expect(read.tasks.map(task => task.title)).toEqual(['Pay invoice']);
    expect(read.canWrite).toBe(false);
  });

  it('moves an event as one span, checked the way a create is', async () => {
    const w = await world();
    const event = await createEvent(w.owner.scope, { title: 'Dinner', allDay: false, start: '2026-12-05T19:00:00.000Z', end: '2026-12-05T21:00:00.000Z', timeZone: 'Europe/Madrid' });
    // Moving the start past the end is a span a create would refuse.
    await expect(w.owner.scope.invoke('drive/update-event', { eventId: event.id, revision: 1, start: '2026-12-05T22:00:00.000Z' }))
      .rejects.toThrow('must end after it starts');
    const moved = await w.owner.scope.invoke<CalendarEvent>('drive/update-event', {
      eventId: event.id, revision: 1, start: '2026-12-06T19:00:00.000Z', end: '2026-12-06T21:00:00.000Z',
    });
    expect(moved).toMatchObject({ start: '2026-12-06T19:00:00.000Z', timeZone: 'Europe/Madrid', revision: 2 });
    // Becoming all-day means dates, and no zone.
    await expect(w.owner.scope.invoke('drive/update-event', { eventId: event.id, revision: 2, allDay: true })).rejects.toThrow('dates');
    const allDay = await w.owner.scope.invoke<CalendarEvent>('drive/update-event', { eventId: event.id, revision: 2, allDay: true, start: '2026-12-06', end: '2026-12-06' });
    expect(allDay).toMatchObject({ allDay: true, timeZone: null, revision: 3 });

    await expect(w.editor.scope.invoke('drive/update-event', { eventId: event.id, revision: 2, title: 'Stale' })).rejects.toThrow('changed since it was read');
    await expect(w.member.scope.invoke('drive/update-event', { eventId: event.id, revision: 3, title: 'Not mine to change' })).rejects.toThrow();

    await w.editor.scope.invoke('drive/delete-event', { eventId: event.id });
    expect((await calendar(w.owner.scope, '2026-12-01', '2026-12-31')).events).toEqual([]);
    await expect(w.editor.scope.invoke('drive/delete-event', { eventId: event.id })).rejects.toThrow('event not found');
  });

  it('refuses a span that is backwards, too long, or written the wrong way for its kind', async () => {
    const w = await world();
    const bad = [
      { allDay: true, start: '2026-12-10', end: '2026-12-09' },
      { allDay: true, start: '2026-12-10T10:00:00.000Z', end: '2026-12-10T11:00:00.000Z' },
      { allDay: false, start: '2026-12-10', end: '2026-12-11' },
      { allDay: false, start: '2026-12-10T10:00:00.000Z', end: '2026-12-10T10:00:00.000Z' },
      { allDay: false, start: '2026-12-10T10:00:00+01:00', end: '2026-12-10T11:00:00+01:00' },
      { allDay: true, start: '2026-01-01', end: '2027-01-02' },
    ];
    for (const times of bad) await expect(createEvent(w.owner.scope, { title: 'Bad', ...times })).rejects.toThrow();
    await expect(createEvent(w.member.scope, { title: 'Not a writer', allDay: true, start: '2026-12-10', end: '2026-12-10' })).rejects.toThrow();
    await expect(createEvent(w.narrow.scope, { title: 'Folder share', allDay: true, start: '2026-12-10', end: '2026-12-10' })).rejects.toThrow();
  });

  it('refuses a window that is backwards or wider than a few months', async () => {
    const w = await world();
    await expect(calendar(w.owner.scope, '2026-12-10', '2026-12-10')).rejects.toThrow();
    await expect(calendar(w.owner.scope, '2026-01-01', '2026-06-01')).rejects.toThrow();
    await expect(calendar(w.narrow.scope, '2026-12-01', '2026-12-31')).rejects.toThrow();
  });
});

describe('eventTimesProblem', () => {
  it('accepts a one-day all-day event and a year at most', () => {
    expect(eventTimesProblem(true, '2026-12-10', '2026-12-10')).toBeNull();
    expect(eventTimesProblem(true, '2026-01-01', '2026-12-31')).toBeNull();
    expect(eventTimesProblem(true, '2028-02-29', '2028-02-29')).toBeNull();
    expect(eventTimesProblem(true, '2027-02-29', '2027-02-29')).not.toBeNull();
  });
});
