import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TEXT_WRAP_KEY, useTextWrapPreference } from './text-wrap-preference';
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.removeItem(TEXT_WRAP_KEY); });
function Harness() { const [wrap, setWrap] = useTextWrapPreference(); return <button aria-pressed={wrap} onClick={() => setWrap(!wrap)}>Wrap</button>; }
it('remembers only the wrap choice across panel remounts', () => {
  const view = render(<Harness />); fireEvent.click(screen.getByRole('button'));
  expect(JSON.parse(localStorage.getItem(TEXT_WRAP_KEY)!)).toEqual({ version: 1, wrap: false });
  view.unmount(); render(<Harness />); expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('false');
});
it('reads current storage when queued cross-tab events arrive, ignores other storage and handles clear', () => {
  render(<Harness />); localStorage.setItem(TEXT_WRAP_KEY, JSON.stringify({ version: 1, wrap: false }));
  act(() => window.dispatchEvent(new StorageEvent('storage', { storageArea: localStorage, key: TEXT_WRAP_KEY, newValue: 'stale' })));
  expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('false');
  localStorage.removeItem(TEXT_WRAP_KEY);
  act(() => window.dispatchEvent(new StorageEvent('storage', { storageArea: sessionStorage, key: TEXT_WRAP_KEY })));
  expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('false');
  act(() => window.dispatchEvent(new StorageEvent('storage', { storageArea: localStorage, key: null })));
  expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('true');
});
it('preserves future records and still permits a session choice when storage fails', () => {
  const future = JSON.stringify({ version: 2, wrap: false }); localStorage.setItem(TEXT_WRAP_KEY, future);
  const view = render(<Harness />); fireEvent.click(screen.getByRole('button')); expect(localStorage.getItem(TEXT_WRAP_KEY)).toBe(future);
  view.unmount(); vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Full'); });
  render(<Harness />); fireEvent.click(screen.getByRole('button')); expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('false');
});
