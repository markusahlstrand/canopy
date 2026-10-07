import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useNavigationGuard, confirmNavigation } from './navigation-guards';
import { Sidebar } from './sidebar';
import { currentSite, selectSite } from './api';
import { openSpace, openSpaceFolder } from './space-navigation';
afterEach(() => { cleanup(); selectSite(null); history.replaceState(null, '', '/'); vi.restoreAllMocks(); });
it('declining a space switch preserves selection, storage, and URL', () => {
  selectSite('space-a');
  history.replaceState(null, '', '/?site=space-a&path=Papers');
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  function Harness() { useNavigationGuard(true); return <Sidebar active="drive" onNavigate={() => {}} onNewFolder={() => {}} onUpload={() => {}} onRetry={() => {}} failed={false}
    sites={[{ slug: 'space-a', name: 'Space A', current: true }, { slug: 'space-b', name: 'Space B', current: false }]} />; }
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Space B' }));
  expect(currentSite()).toBe('space-a');
  expect(localStorage.getItem('canopy.site')).toBe('space-a');
  expect(location.search).toBe('?site=space-a&path=Papers');
});
it('an explicitly approved exit suppresses the second browser prompt', () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  function Harness() { useNavigationGuard(true); return null; }
  render(<Harness />);
  expect(confirmNavigation()).toBe(true);
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
});
it('keeps a shared folder target while switching spaces', () => {
  selectSite('space-a');
  history.replaceState(null, '', '/?file=old&path=Old&claim=old-claim&invite=old-invite#previous');
  expect(openSpaceFolder('space-b', 'folder-42')).toBe(true);
  expect(currentSite()).toBe('space-b');
  expect(location.search).toBe('?folder=folder-42');
  expect(location.hash).toBe('');
});
it('drops the previous folder and link credentials when opening another space', () => {
  selectSite('space-a');
  history.replaceState(null, '', '/?site=space-a&folder=old&claim=old-claim&invite=old-invite#previous');
  expect(openSpace('space-b')).toBe(true);
  expect(currentSite()).toBe('space-b');
  expect(location.search).toBe('');
  expect(location.hash).toBe('');
});
