import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PreviewPanel } from './preview';

const version = { keep: 0, id: 'v', file_id: 'file', source: 'blob', blob_ref: 'blob', mime: 'application/zip', size: 1, created_at: '2026-08-01T00:00:00Z' };
const file = { id: 'file', name: 'archive.zip', current_version_id: 'v' };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mockFile() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
    url.endsWith('/versions') ? [version] : url.endsWith('/comments') ? [] : { file, version, canWrite: false },
  ))));
}

describe('switching between the docked pane and full screen', () => {
  it('asks the host to go full screen from the docked pane', async () => {
    mockFile();
    const change = vi.fn();
    render(<PreviewPanel fileId="file" onClose={() => {}} onError={() => {}} mode="split" onModeChange={change} />);
    await screen.findByText('archive.zip');
    fireEvent.click(screen.getByRole('button', { name: 'Open full screen' }));
    expect(change).toHaveBeenCalledWith('full');
  });

  it('asks the host to dock again from full screen, without the fixed pane width', async () => {
    mockFile();
    const change = vi.fn();
    render(<PreviewPanel fileId="file" onClose={() => {}} onError={() => {}} mode="full" onModeChange={change} />);
    await screen.findByText('archive.zip');
    expect(screen.getByRole('complementary', { name: 'Preview' }).className).not.toContain('md:w-[28rem]');
    fireEvent.click(screen.getByRole('button', { name: 'Dock to the side' }));
    expect(change).toHaveBeenCalledWith('split');
  });

  it('offers no switch when the host does not handle one', async () => {
    mockFile();
    render(<PreviewPanel fileId="file" onClose={() => {}} onError={() => {}} />);
    await screen.findByText('archive.zip');
    expect(screen.queryByRole('button', { name: 'Open full screen' })).toBeNull();
  });
});
