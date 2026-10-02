import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PreviewPanel, shapeOf } from './preview';
import { selectSite } from './api';
afterEach(() => { cleanup(); selectSite(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it.each(['audio/mpeg', 'video/mp4'])('plays %s through a permission-checked immutable version URL', async mime => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  selectSite('family');
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ file: { id: 'file', name: 'clip' }, version: { id: 'v1', mime }, canWrite: false })));
  const view = render(<PreviewPanel fileId="file" onClose={() => {}} onError={() => {}} />);
  const media = await screen.findByLabelText('clip') as HTMLMediaElement;
  expect(media.getAttribute('src')).toBe('/api/files/file/versions/v1/content?site=family');
  expect(media.controls).toBe(true);
  expect(media.autoplay).toBe(false);
  expect(media.preload).toBe('metadata');
  fireEvent.error(media);
  expect(screen.getByText('This browser could not play clip. Download it to open it.')).toBeTruthy();
  expect(media.getAttribute('src')).toBeNull();
  expect(media.pause).toHaveBeenCalled();
  view.unmount();
});
it('normalizes media MIME parameters', () => {
  expect(shapeOf('Audio/OGG; codecs=opus')).toBe('audio');
  expect(shapeOf('video/webm')).toBe('video');
});
