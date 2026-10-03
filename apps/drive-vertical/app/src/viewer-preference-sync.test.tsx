import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ViewersDialog } from './viewers-dialog';
import { IMAGE_VIEWER_PREFERENCE, setImageViewerEnabled, viewerRegistry, watchImageViewerPreference } from './image-viewer';
let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; cleanup(); vi.restoreAllMocks(); setImageViewerEnabled(true); localStorage.removeItem(IMAGE_VIEWER_PREFERENCE); });
const writeOtherTab = Storage.prototype.setItem;
const dispatch = (value: string | null, key: string | null = IMAGE_VIEWER_PREFERENCE, storageArea: Storage = localStorage) =>
  act(() => {
    // The browser updates storage before delivering the event; bypass spies for the other tab's write.
    if (key === null) storageArea.clear();
    else if (value === null) storageArea.removeItem(key);
    else writeOtherTab.call(storageArea, key, value);
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: value, storageArea }));
  });
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
it('ignores other keys and storage areas, and stops after cleanup', () => {
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

it('keeps the latest local toggle when an older other-tab event arrives later', () => {
  stop = watchImageViewerPreference();
  setImageViewerEnabled(false);
  setImageViewerEnabled(true);
  const write = vi.spyOn(Storage.prototype, 'setItem');
  act(() => { window.dispatchEvent(new StorageEvent('storage', { key: IMAGE_VIEWER_PREFERENCE, newValue: 'disabled', storageArea: localStorage })); });
  expect(viewerRegistry.has('image-viewer')).toBe(true);
  expect(localStorage.getItem(IMAGE_VIEWER_PREFERENCE)).toBe('enabled');
  expect(write).not.toHaveBeenCalled();
});
it('uses the same unknown-value default during event handling and registration', () => {
  stop = watchImageViewerPreference();
  setImageViewerEnabled(false);
  dispatch('future-value');
  expect(viewerRegistry.has('image-viewer')).toBe(true);
});
it('does not apply an old clear event over a newer disabled preference', () => {
  stop = watchImageViewerPreference();
  setImageViewerEnabled(false);
  act(() => { window.dispatchEvent(new StorageEvent('storage', { key: null, newValue: null, storageArea: localStorage })); });
  expect(viewerRegistry.has('image-viewer')).toBe(false);
});
