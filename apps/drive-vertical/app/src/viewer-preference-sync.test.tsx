import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ViewersDialog } from './viewers-dialog';
import { IMAGE_VIEWER_PREFERENCE, setImageViewerEnabled, viewerRegistry, watchImageViewerPreference } from './image-viewer';
let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; cleanup(); vi.restoreAllMocks(); setImageViewerEnabled(true); localStorage.removeItem(IMAGE_VIEWER_PREFERENCE); });
const dispatch = (value: string | null, key: string | null = IMAGE_VIEWER_PREFERENCE, storageArea: Storage = localStorage) =>
  act(() => { window.dispatchEvent(new StorageEvent('storage', { key, newValue: value, storageArea })); });
it('updates the open management dialog from another tab without echoing writes', () => {
  setImageViewerEnabled(true);
  stop = watchImageViewerPreference();
  render(<ViewersDialog open onOpenChange={() => {}} />);
  const write = vi.spyOn(Storage.prototype, 'setItem');
  dispatch('disabled');
  expect(screen.getByText('Disabled')).toBeTruthy();
  expect(viewerRegistry.has('image-viewer')).toBe(false);
  dispatch('enabled');
  expect(screen.getByText('Enabled')).toBeTruthy();
  expect(write).not.toHaveBeenCalled();
});
it('ignores other keys, storage areas and future values, and stops after cleanup', () => {
  setImageViewerEnabled(true);
  stop = watchImageViewerPreference();
  dispatch('disabled', 'unrelated');
  dispatch('disabled', IMAGE_VIEWER_PREFERENCE, sessionStorage);
  dispatch('future-value');
  expect(viewerRegistry.has('image-viewer')).toBe(true);
  stop(); stop = undefined;
  dispatch('disabled');
  expect(viewerRegistry.has('image-viewer')).toBe(true);
});
it('restores the default after preference deletion or storage clearing', () => {
  stop = watchImageViewerPreference();
  dispatch('disabled');
  dispatch(null);
  expect(viewerRegistry.has('image-viewer')).toBe(true);
  dispatch('disabled');
  dispatch(null, null);
  expect(viewerRegistry.has('image-viewer')).toBe(true);
});
