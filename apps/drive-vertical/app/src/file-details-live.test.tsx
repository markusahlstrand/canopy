import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FileDetailsPanel } from './file-details';
const live = vi.hoisted(() => ({ changed: () => {}, stop: vi.fn(), watch: vi.fn() }));
vi.mock('./live-updates', () => ({ watchDriveChanges: (changed: () => void, entity: unknown) => {
  live.changed = changed; live.watch(entity); return live.stop;
} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const details = (description = 'Original', canWrite = true) => ({ fileId: 'file', description, labels: ['work'], revision: 3, canWrite });
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
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Details changed elsewhere/)).toBeTruthy();
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
