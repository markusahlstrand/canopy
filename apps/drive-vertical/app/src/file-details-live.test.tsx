import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FileDetailsPanel } from './file-details';
import { hasUnsavedDrafts } from './drafts';
const live = vi.hoisted(() => ({ changed: () => {}, stop: vi.fn(), watch: vi.fn() }));
vi.mock('./live-updates', () => ({ watchDriveChanges: (changed: () => void, entity: unknown) => {
  live.changed = changed; live.watch(entity); return live.stop;
} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const details = (description = 'Original', canWrite = true) => ({ fileId: 'file', description, labels: ['work'], revision: description === 'Original' ? 3 : 4, canWrite });
function mockReads(canWrite = true) {
  let reads = 0;
  const fetcher = vi.fn(async () => new Response(JSON.stringify(details(++reads > 1 ? 'Remote' : 'Original', canWrite))));
  vi.stubGlobal('fetch', fetcher); return fetcher;
}
describe('live file details', () => {
  it.each([true, false])('refreshes clean metadata for canWrite=%s', async canWrite => {
    const fetcher = mockReads(canWrite);
    const view = render(<FileDetailsPanel fileId="file" />);
    if (canWrite) await screen.findByDisplayValue('Original'); else await screen.findByText('Original');
    act(() => live.changed());
    if (canWrite) await screen.findByDisplayValue('Remote'); else await screen.findByText('Remote');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(live.watch).toHaveBeenCalledWith({ entityType: 'file', entityId: 'file' });
    view.unmount(); expect(live.stop).toHaveBeenCalled();
  });
  it('preserves drafts on a notification until an explicit reload', async () => {
    const fetcher = mockReads(); render(<FileDetailsPanel fileId="file" />);
    await screen.findByDisplayValue('Original');
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Draft' } });
    act(() => live.changed());
    expect(screen.getByDisplayValue('Draft')).toBeTruthy();
    await screen.findByText(/Details changed elsewhere/);
    expect(fetcher).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Reload details' }));
    await screen.findByDisplayValue('Remote');
    expect(screen.queryByText(/Details changed elsewhere/)).toBeNull();
  });
  it('preserves editing that starts while a background read is pending', async () => {
    let answer!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(details())))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { answer = resolve; })));
    render(<FileDetailsPanel fileId="file" />); await screen.findByDisplayValue('Original');
    act(() => live.changed());
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Draft' } });
    await act(async () => answer(new Response(JSON.stringify(details('Remote')))));
    expect(screen.getByDisplayValue('Draft')).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Details changed elsewhere/)).toBeTruthy());
  });
});

it('does not announce a metadata change for poll/comment nudges with the same revision', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(details()))); vi.stubGlobal('fetch', fetcher);
  render(<FileDetailsPanel fileId="file" />); await screen.findByDisplayValue('Original');
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Draft' } });
  for (let i = 0; i < 2; i++) { await act(async () => live.changed()); }
  expect(fetcher).toHaveBeenCalledTimes(3); expect(screen.queryByText(/Details changed elsewhere/)).toBeNull();
  expect(screen.getByDisplayValue('Draft')).toBeTruthy(); expect(hasUnsavedDrafts()).toBe(true);
});
it.each(['Description', 'Labels'])('rebases remote changes to an untouched field while preserving a local %s draft', async field => {
  const remote = field === 'Description' ? { ...details(), labels: ['remote'], revision: 4 } : details('Remote');
  let reads = 0;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return new Response(JSON.stringify({ ...remote, ...JSON.parse(init.body as string), revision: 5 }));
    return new Response(JSON.stringify(++reads === 1 ? details() : remote));
  }); vi.stubGlobal('fetch', fetcher);
  render(<FileDetailsPanel fileId="file" />); await screen.findByDisplayValue('Original');
  fireEvent.change(screen.getByLabelText(field), { target: { value: 'Draft' } });
  await act(async () => live.changed());
  expect(screen.getByDisplayValue('Draft')).toBeTruthy();
  expect(screen.getByDisplayValue(field === 'Description' ? 'remote' : 'Remote')).toBeTruthy();
  expect(screen.queryByText(/Details changed elsewhere/)).toBeNull(); expect(hasUnsavedDrafts()).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
  await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true));
  const sent = JSON.parse(fetcher.mock.calls.find(([, init]) => init?.method === 'PATCH')![1]!.body as string);
  expect(sent).toEqual({ description: field === 'Description' ? 'Draft' : 'Remote', labels: field === 'Description' ? ['remote'] : ['Draft'], expectedRevision: 4 });
  await waitFor(() => expect(hasUnsavedDrafts()).toBe(false));
});
it('keeps overlapping label edits and the original revision until explicit reload', async () => {
  let reads = 0; let sent: unknown;
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') { sent = JSON.parse(init.body as string); return new Response('Conflict', { status: 409 }); }
    return new Response(JSON.stringify(++reads === 1 ? details() : { ...details(), labels: ['Remote'], revision: 4 }));
  }); render(<FileDetailsPanel fileId="file" />); await screen.findByDisplayValue('Original');
  fireEvent.change(screen.getByLabelText('Labels'), { target: { value: 'Draft' } });
  await act(async () => live.changed()); expect(screen.getByDisplayValue('Draft')).toBeTruthy();
  expect(screen.getByText(/Details changed elsewhere/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save details' })); await screen.findByRole('alert');
  expect(sent).toEqual({ description: 'Original', labels: ['Draft'], expectedRevision: 3 });
});
it('clears the draft guard when the remote value matches the local edit', async () => {
  let reads = 0; vi.stubGlobal('fetch', async () => new Response(JSON.stringify(++reads === 1 ? details() : details('Draft'))));
  render(<FileDetailsPanel fileId="file" />); await screen.findByDisplayValue('Original');
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Draft' } });
  expect(hasUnsavedDrafts()).toBe(true); await act(async () => live.changed());
  expect(hasUnsavedDrafts()).toBe(false); expect(screen.queryByText(/Details changed elsewhere/)).toBeNull();
});
it('ignores background failures and preserves user-action validation errors', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(details()))).mockRejectedValue(new Error('Offline'));
  vi.stubGlobal('fetch', fetcher); render(<FileDetailsPanel fileId="file" />); await screen.findByDisplayValue('Original');
  await act(async () => live.changed()); expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.change(screen.getByLabelText('Labels'), { target: { value: 'x'.repeat(101) } });
  fireEvent.click(screen.getByRole('button', { name: 'Save details' })); const error = screen.getByRole('alert').textContent;
  await act(async () => live.changed()); expect(screen.getByRole('alert').textContent).toBe(error);
});
