import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TasksView } from './tasks-view';
import type { Task } from './api';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const task = (over: Partial<Task> & { id: string; title: string }): Task => ({
  notes: '', status: 'needs-action', due: null,
  createdAt: '2026-11-01T00:00:00Z', createdBy: 'p1', updatedAt: '2026-11-01T00:00:00Z', updatedBy: 'p1',
  completedAt: null, completedBy: null, revision: 1, ...over,
});

function mockApi(tasks: Task[], { canWrite = true, conflict = false } = {}) {
  let current = tasks;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'PATCH') {
      if (conflict) return new Response(JSON.stringify({ detail: 'changed' }), { status: 409 });
      const id = decodeURIComponent(url.split('/').at(-1)!);
      const body = JSON.parse(init!.body as string) as Partial<Task> & { revision: number };
      current = current.map(t => (t.id === id ? { ...t, ...body, revision: t.revision + 1 } : t));
      return new Response(JSON.stringify(current.find(t => t.id === id)));
    }
    if (method === 'POST') {
      const body = JSON.parse(init!.body as string) as { title: string; due: string | null };
      const created = task({ id: `t${current.length + 1}`, title: body.title, due: body.due });
      current = [...current, created];
      return new Response(JSON.stringify(created));
    }
    return new Response(JSON.stringify({ tasks: current, canWrite }));
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('the tasks view', () => {
  it('lists the space’s tasks and ticks one off against the revision it read', async () => {
    const fetch = mockApi([task({ id: 't1', title: 'Pay the electricity bill', due: '2026-01-05', revision: 4 }), task({ id: 't2', title: 'Book dentist' })]);
    render(<TasksView />);
    expect(await screen.findByText('Pay the electricity bill')).toBeTruthy();
    // Long past: flagged.
    expect(screen.getByText(/5 Jan|Jan 5/).closest('span')?.className).toContain('destructive');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Mark as done: Pay the electricity bill' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tasks/t1', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ revision: 4, status: 'completed' }),
    })));
    expect(await screen.findByRole('checkbox', { name: 'Mark as not done: Pay the electricity bill' })).toBeTruthy();
  });

  it('adds a task with a due date', async () => {
    const fetch = mockApi([]);
    render(<TasksView />);
    expect(await screen.findByText('Nothing to do')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('New task'), { target: { value: 'Renew passport' } });
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-12-20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tasks', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ title: 'Renew passport', due: '2026-12-20' }),
    })));
    expect(await screen.findByText('Renew passport')).toBeTruthy();
  });

  it('says so and reads again when someone changed the task first', async () => {
    const fetch = mockApi([task({ id: 't1', title: 'Water plants' })], { conflict: true });
    render(<TasksView />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Mark as done: Water plants' }));
    expect(await screen.findByText('Someone changed this task in the meantime. Showing the latest.')).toBeTruthy();
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/tasks?')).length).toBe(2));
  });

  it('is read-only for someone who can only read the space', async () => {
    mockApi([task({ id: 't1', title: 'Water plants' })], { canWrite: false });
    render(<TasksView />);
    const box = await screen.findByRole('checkbox', { name: 'Mark as done: Water plants' });
    expect(box.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByLabelText('New task')).toBeNull();
  });
});
