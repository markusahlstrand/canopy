import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FileViewerRegistry } from '@canopy/plugin-sdk/viewer-registry';
import { PreviewPanel } from './preview';
import { viewerRegistry } from './image-viewer';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
class TestViewer extends HTMLElement { file = null; }
class OtherViewer extends HTMLElement { file = null; }
it('uses manifest MIME and extension rules, supports removal, and rejects duplicate installs', () => {
  const registry = new FileViewerRegistry();
  const dispose = registry.install({ id: 'test', contributes: { viewers: [{ id: 'test', match: ['.abc', 'application/x-abc'] }] } }, { test: { tagName: 'test-abc-viewer', constructor: TestViewer } });
  expect(registry.resolve({ mime: 'application/x-abc; charset=utf-8', name: 'file' })?.id).toBe('test');
  expect(registry.resolve({ mime: '', name: 'FILE.ABC' })?.id).toBe('test');
  expect(() => registry.install({ id: 'test' }, {})).toThrow('already installed');
  dispose(); dispose();
  expect(registry.resolve({ mime: '', name: 'file.abc' })).toBeNull();
});
it('prefers exact MIME matches over wildcards', () => {
  const registry = new FileViewerRegistry();
  registry.install({ id: 'generic', contributes: { viewers: [{ id: 'all', match: ['image/*'] }] } }, { all: { tagName: 'generic-image-test', constructor: class extends HTMLElement {} } });
  registry.install({ id: 'specific', contributes: { viewers: [{ id: 'png', match: ['image/png'] }] } }, { png: { tagName: 'png-image-test', constructor: class extends HTMLElement {} } });
  expect(registry.resolve({ mime: 'IMAGE/PNG', name: '' })?.pluginId).toBe('specific');
});
it('refreshes an open preview when a reviewed viewer is installed and removed', async () => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ file: { id: 'file', name: 'file.abc' }, version: { id: 'v1', mime: 'application/x-abc' } })));
  const view = render(<PreviewPanel fileId="file" onClose={() => {}} onError={() => {}} />);
  await screen.findByText(/No preview for/);
  let dispose!: () => void;
  act(() => { dispose = viewerRegistry.install({ id: 'preview-test', contributes: { viewers: [{ id: 'abc', match: ['.abc'] }] } }, { abc: { tagName: 'preview-abc-test', constructor: OtherViewer } }); });
  await waitFor(() => expect(view.container.querySelector('preview-abc-test')).toBeTruthy());
  const element = view.container.querySelector('preview-abc-test') as OtherViewer;
  expect(element.file).toMatchObject({ id: 'file', name: 'file.abc', contentUrl: '/api/files/file/content' });
  act(() => dispose());
  await screen.findByText(/No preview for/);
  expect(element.file).toBeNull();
});

it('rejects a colliding batch before defining any of its elements', () => {
  const registry = new FileViewerRegistry();
  const manifest = { id: 'collision', contributes: { viewers: [{ id: 'one', match: ['.one'] }, { id: 'two', match: ['.two'] }] } };
  expect(() => registry.install(manifest, {
    one: { tagName: 'batch-collision-test', constructor: class extends HTMLElement {} },
    two: { tagName: 'batch-collision-test', constructor: class extends HTMLElement {} }
  })).toThrow('definition collision');
  expect(customElements.get('batch-collision-test')).toBeUndefined();
  expect(registry.snapshot()).toBe(0);
});
it('ranks MIME wildcards above renamed file extensions using the core matcher', () => {
  const registry = new FileViewerRegistry();
  registry.install({ id: 'extension', contributes: { viewers: [{ id: 'abc', match: ['.abc'] }] } }, { abc: { tagName: 'rename-abc-viewer', constructor: class extends HTMLElement {} } });
  registry.install({ id: 'images', contributes: { viewers: [{ id: 'images', match: ['image/*'] }] } }, { images: { tagName: 'rename-images-viewer', constructor: class extends HTMLElement {} } });
  expect(registry.resolve({ mime: 'image/png', name: 'photo.abc' })?.pluginId).toBe('images');
  expect(registry.resolve({ mime: '', name: 'photo.abc' })?.pluginId).toBe('extension');
});
it('does not remount an open viewer for an unrelated installation', async () => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ file: { id: 'file', name: 'photo.png' }, version: { id: 'v1', mime: 'image/png' } })));
  const view = render(<PreviewPanel fileId="file" onClose={() => {}} onError={() => {}} />);
  await waitFor(() => expect(view.container.querySelector('canopy-image-viewer')).toBeTruthy());
  const element = view.container.querySelector('canopy-image-viewer');
  let dispose!: () => void;
  act(() => { dispose = viewerRegistry.install({ id: 'unrelated', contributes: { viewers: [{ id: 'other', match: ['.other'] }] } }, { other: { tagName: 'unrelated-test-viewer', constructor: class extends HTMLElement {} } }); });
  expect(view.container.querySelector('canopy-image-viewer')).toBe(element);
  act(() => dispose());
});

it('keeps an open text draft and its editor when a viewer claiming text is installed', async () => {
  vi.stubGlobal('fetch', async (url: string) => url.includes('/content') ? new Response('original') : new Response(JSON.stringify({ file: { id: 'file', name: 'notes.md' }, version: { id: 'v1', mime: 'text/markdown', source: 'blob' }, canWrite: true })));
  render(<PreviewPanel fileId="file" onClose={() => {}} onError={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit text' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'File text' }), { target: { value: 'Keep this draft' } });
  let dispose!: () => void;
  act(() => { dispose = viewerRegistry.install({ id: 'text-test', contributes: { viewers: [{ id: 'text', match: ['text/*', '.md'] }] } }, { text: { tagName: 'text-draft-test-viewer', constructor: class extends HTMLElement {} } }); });
  expect(screen.getByDisplayValue('Keep this draft')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Save text' })).toBeTruthy();
  act(() => dispose());
});
