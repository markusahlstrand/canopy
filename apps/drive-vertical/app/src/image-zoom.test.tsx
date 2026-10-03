import { afterEach, expect, it } from 'vitest';
import { fireEvent, within } from '@testing-library/react';
import { IMAGE_VIEWER_TAG, ImageViewer, registerImageViewer } from './image-viewer';
afterEach(() => document.body.replaceChildren());
function setup() {
  registerImageViewer(); const viewer = document.createElement(IMAGE_VIEWER_TAG) as ImageViewer; document.body.append(viewer);
  viewer.file = { id: 'image', name: 'photo.png', mime: 'image/png', contentUrl: '/api/files/image/content' };
  const image = viewer.shadowRoot!.querySelector('img')!;
  Object.defineProperties(image, { naturalWidth: { value: 800, configurable: true }, naturalHeight: { value: 600, configurable: true }, clientWidth: { value: 400, configurable: true } });
  const controls = within(viewer.shadowRoot! as unknown as HTMLElement); return { viewer, image, controls };
}
it('fits without upscaling, zooms from the fitted scale, and offers actual pixels', () => {
  const { image, controls } = setup();
  expect((controls.getByRole('button', { name: 'Zoom in' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.load(image); expect(image.style.maxWidth).toBe('min(100%, 800px)');
  fireEvent.click(controls.getByRole('button', { name: 'Zoom in' }));
  expect(controls.getByRole('status').textContent).toBe('63%'); expect(image.style.width).toBe('500px');
  fireEvent.click(controls.getByRole('button', { name: 'Actual size' })); expect(image.style.width).toBe('800px');
  fireEvent.click(controls.getByRole('button', { name: 'Fit image' })); expect(image.style.width).toBe('auto');
  expect(controls.getByRole('status').textContent).toBe('Fit');
});
it('bounds zoom and resets its controls/source when a different file replaces or clears it', () => {
  const { viewer, image, controls } = setup(); fireEvent.load(image);
  for (let i = 0; i < 20; i++) fireEvent.click(controls.getByRole('button', { name: 'Zoom in' }));
  expect(controls.getByRole('status').textContent).toBe('400%'); expect((controls.getByRole('button', { name: 'Zoom in' }) as HTMLButtonElement).disabled).toBe(true);
  for (let i = 0; i < 20; i++) fireEvent.click(controls.getByRole('button', { name: 'Zoom out' }));
  expect(controls.getByRole('status').textContent).toBe('25%'); expect((controls.getByRole('button', { name: 'Zoom out' }) as HTMLButtonElement).disabled).toBe(true);
  viewer.file = { id: 'other', name: 'other.png', mime: 'image/png', contentUrl: '/api/files/other/content' };
  expect(controls.getByRole('status').textContent).toBe('Fit'); expect(image.alt).toBe('other.png');
  expect((controls.getByRole('button', { name: 'Zoom in' }) as HTMLButtonElement).disabled).toBe(true);
  viewer.file = null; expect(image.hasAttribute('src')).toBe(false); expect(image.alt).toBe('');
});

it('never enlarges a very large fitted photo when zooming out and takes proportional steps', () => {
  const { image, controls } = setup();
  Object.defineProperties(image, { naturalWidth: { value: 20_000 }, naturalHeight: { value: 15_000 } });
  fireEvent.load(image);
  expect((controls.getByRole('button', { name: 'Zoom out' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(controls.getByRole('button', { name: 'Zoom out' })); expect(image.style.width).toBe('auto');
  fireEvent.click(controls.getByRole('button', { name: 'Zoom in' })); expect(image.style.width).toBe('500px');
  fireEvent.click(controls.getByRole('button', { name: 'Zoom out' })); expect(parseFloat(image.style.width)).toBeCloseTo(400);
  expect((controls.getByRole('button', { name: 'Zoom out' }) as HTMLButtonElement).disabled).toBe(true);
});
it('preserves the visible centre across zoom steps and actual size, and resets only for Fit/new files', () => {
  const { viewer, image, controls } = setup(); const viewport = viewer.shadowRoot!.querySelector('.viewport')! as HTMLDivElement;
  Object.defineProperties(viewport, { clientWidth: { value: 400 }, clientHeight: { value: 300 } });
  fireEvent.load(image); fireEvent.click(controls.getByRole('button', { name: 'Actual size' }));
  viewport.scrollLeft = 120; viewport.scrollTop = 90;
  fireEvent.click(controls.getByRole('button', { name: 'Zoom in' }));
  expect(viewport.scrollLeft).toBe(200); expect(viewport.scrollTop).toBe(150);
  fireEvent.click(controls.getByRole('button', { name: 'Zoom out' }));
  expect(viewport.scrollLeft).toBe(120); expect(viewport.scrollTop).toBe(90);
  fireEvent.click(controls.getByRole('button', { name: 'Fit image' }));
  expect(viewport.scrollLeft).toBe(0); expect(viewport.scrollTop).toBe(0);
  viewport.scrollLeft = 99; viewer.file = null; expect(viewport.scrollLeft).toBe(0);
});

it('scopes keyboard zoom to the loaded viewport and preserves browser shortcuts', () => {
  const { image, controls } = setup(); const viewport = controls.getByRole('region', { name: 'Image viewport' });
  expect(viewport.tabIndex).toBe(0); fireEvent.keyDown(viewport, { key: '+' }); expect(image.style.width).toBe('auto');
  fireEvent.load(image); fireEvent.keyDown(viewport, { key: '+', shiftKey: true }); expect(image.style.width).toBe('500px');
  fireEvent.keyDown(viewport, { key: '0' }); expect(image.style.width).toBe('800px');
  const browser = new KeyboardEvent('keydown', { key: '+', ctrlKey: true, cancelable: true }); viewport.dispatchEvent(browser);
  expect(browser.defaultPrevented).toBe(false); expect(image.style.width).toBe('800px');
  fireEvent.keyDown(viewport, { key: '-', isComposing: true }); expect(image.style.width).toBe('800px');
  fireEvent.keyDown(image, { key: '+', bubbles: true }); expect(image.style.width).toBe('800px');
  fireEvent.keyDown(viewport, { key: 'F', shiftKey: true }); expect(image.style.width).toBe('auto'); expect(controls.getByRole('status').textContent).toBe('Fit');
});

it('describes all zoom shortcuts and hides the hint before load and after failure', () => {
  const { viewer, image, controls } = setup();
  const hint = viewer.shadowRoot!.querySelector('#zoom-shortcuts') as HTMLElement;
  expect(controls.getByRole('region').getAttribute('aria-keyshortcuts')).toBe('Plus = - 0 F');
  expect(hint.hidden).toBe(true); fireEvent.load(image); expect(hint.hidden).toBe(false);
  fireEvent.error(image); expect(hint.hidden).toBe(true);
  expect((controls.getByRole('button', { name: 'Zoom in' }) as HTMLButtonElement).disabled).toBe(true);
});
