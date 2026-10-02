import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FileDetailsPanel } from './file-details';

const initial = { fileId: 'file', description: 'Original', labels: ['work'], revision: 3, canWrite: true };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mockDetails(canWrite = true, conflict = false) {
  let reads = 0;
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      if (conflict) return new Response('details changed', { status: 409 });
      const body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ ...initial, ...body, revision: 4 }));
    }
    reads++;
    return new Response(JSON.stringify({ ...initial, description: reads > 1 ? 'Changed elsewhere' : 'Original', canWrite }));
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('file details editing', () => {
  it('saves description and normalized labels against the loaded revision', async () => {
    const fetch = mockDetails();
    render(<FileDetailsPanel fileId="file" />);
    await screen.findByDisplayValue('Original');
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Updated' } });
    fireEvent.change(screen.getByLabelText('Labels'), { target: { value: ' work \nfamily\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/files/file/details', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ description: 'Updated', labels: ['work', 'family'], expectedRevision: 3 }) })));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save details' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('renders metadata without editing controls for readers', async () => {
    mockDetails(false);
    render(<FileDetailsPanel fileId="file" />);
    await screen.findByText('Original');
    expect(screen.getByText('work')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save details' })).toBeNull();
  });

  it('preserves a conflicting draft until the user reloads the latest details', async () => {
    mockDetails(true, true);
    render(<FileDetailsPanel fileId="file" />);
    await screen.findByDisplayValue('Original');
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'My draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
    await screen.findByRole('alert');
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('My draft');
    expect((screen.getByRole('button', { name: 'Save details' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Reload details' }));
    await screen.findByDisplayValue('Changed elsewhere');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('bounds labels before sending a write', async () => {
    const fetch = mockDetails();
    render(<FileDetailsPanel fileId="file" />);
    await screen.findByDisplayValue('Original');
    fireEvent.change(screen.getByLabelText('Labels'), { target: { value: Array.from({ length: 21 }, (_, i) => `label${i}`).join('\n') } });
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
    await screen.findByRole('alert');
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });
});
