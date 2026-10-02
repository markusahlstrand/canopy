import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PreviewPanel, shapeOf } from './preview';
import { selectSite } from './api';
afterEach(() => { cleanup(); selectSite(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it.each(['audio/mpeg', 'video/mp4'])('plays %s through a permission-checked immutable version URL', async mime => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  selectSite('family');
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ file: { id: 'file', name: 'clip' }, version: { id: 'v1', mime, source: 'blob' }, canWrite: false })));
  const view = render(<PreviewPanel fileId="file" onClose={() => {}} onError={() => {}} />);
  const media = await screen.findByLabelText('clip') as HTMLMediaElement;
  expect(media.getAttribute('src')).toBe('/api/files/file/versions/v1/content?site=family');
  expect(media.controls).toBe(true);
  expect(media.autoplay).toBe(false);
  expect(media.preload).toBe('metadata');
  fireEvent.error(media);
  expect(screen.getByRole('link', { name: 'Download this version' })).toBeTruthy();
  expect(media.getAttribute('src')).toBeNull();
  expect(media.pause).toHaveBeenCalled();
  view.unmount();
});
it('normalizes media MIME parameters', () => {
  expect(shapeOf('Audio/OGG; codecs=opus')).toBe('audio');
  expect(shapeOf('video/webm')).toBe('video');
});
it('does not offer playback or download for an external media version', async () => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ file: { id: 'file', name: 'external clip' }, version: { id: 'v1', mime: 'video/mp4', source: 'external' } })));
  const view = render(<PreviewPanel fileId="file" onClose={() => {}} onError={() => {}} />);
  await screen.findByText(/This version lives in a connected source/);
  expect(view.container.querySelector('video')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Download' })).toBeNull();
});
