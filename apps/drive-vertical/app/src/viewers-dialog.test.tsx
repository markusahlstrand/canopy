import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ViewersDialog } from './viewers-dialog';
import { PreviewPanel } from './preview';
import { IMAGE_VIEWER_PREFERENCE, registerImageViewer, setImageViewerEnabled, viewerRegistry } from './image-viewer';
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setImageViewerEnabled(true); localStorage.removeItem(IMAGE_VIEWER_PREFERENCE); });
it('enables and disables the bundled image viewer and remembers the choice', () => {
  setImageViewerEnabled(true);
  render(<ViewersDialog open onOpenChange={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Disable image viewer' }));
  expect(screen.getByText('Disabled')).toBeTruthy();
  expect(viewerRegistry.has('image-viewer')).toBe(false);
  expect(localStorage.getItem(IMAGE_VIEWER_PREFERENCE)).toBe('disabled');
  registerImageViewer();
  expect(viewerRegistry.has('image-viewer')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Enable image viewer' }));
  expect(viewerRegistry.resolve({ mime: 'image/png', name: 'photo.png' })?.pluginId).toBe('image-viewer');
  expect(localStorage.getItem(IMAGE_VIEWER_PREFERENCE)).toBe('enabled');
});
it('retires an open image on disable and restores it on enable', async () => {
  setImageViewerEnabled(true);
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ file: { id: 'file', name: 'photo.png' }, version: { id: 'v1', mime: 'image/png' } })));
  const view = render(<><PreviewPanel fileId="file" onClose={() => {}} onError={() => {}} /><ViewersDialog open onOpenChange={() => {}} /></>);
  await waitFor(() => expect(view.container.querySelector('canopy-image-viewer')).toBeTruthy());
  const old = view.container.querySelector('canopy-image-viewer') as HTMLElement & { file: unknown };
  fireEvent.click(screen.getByRole('button', { name: 'Disable image viewer' }));
  await waitFor(() => expect(view.container.querySelector('canopy-image-viewer')).toBeNull());
  expect(old.file).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Enable image viewer' }));
  await waitFor(() => expect(view.container.querySelector('canopy-image-viewer')).toBeTruthy());
});
it('toggles for this session even if storage is blocked', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(() => setImageViewerEnabled(false)).not.toThrow();
  expect(viewerRegistry.has('image-viewer')).toBe(false);
  setImageViewerEnabled(true);
  expect(viewerRegistry.has('image-viewer')).toBe(true);
});
