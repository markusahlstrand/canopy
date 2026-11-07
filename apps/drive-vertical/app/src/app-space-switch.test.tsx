import 'fake-indexeddb/auto';
import { useEffect } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { currentSite, selectSite, whoami } from './api';
import { openSpace, openSpaceFile } from './space-navigation';
import { confirmNavigation, useNavigationGuard } from './navigation-guards';
import { resumeMirror } from './scope-mirror';
import { publishPlugins } from './installed-plugins';

const mounts = vi.fn();
vi.mock('./drive', async () => {
  const { currentSite } = await import('./api');
  return {
    DriveScreen: ({ auth }: { auth: { principal: string } }) => {
      useEffect(() => { mounts(); }, []);
      return <p>{auth.principal} in {currentSite() ?? 'home'}</p>;
    },
  };
});
vi.mock('./scope-mirror', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scope-mirror')>();
  return { ...actual, resumeMirror: vi.fn(actual.resumeMirror) };
});
vi.mock('./installed-plugins', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./installed-plugins')>();
  return { ...actual, publishPlugins: vi.fn(actual.publishPlugins) };
});
vi.mock('./api', async (importOriginal) => ({ ...await importOriginal<typeof import('./api')>(), whoami: vi.fn() }));

afterEach(() => { cleanup(); selectSite(null); history.replaceState(null, '', '/'); vi.clearAllMocks(); });

it('switches space in place: asks the new space who we are first, then remounts only the drive', async () => {
  selectSite('space-a');
  history.replaceState(null, '', '/?path=Papers');
  let answer!: (me: { principal: string }) => void;
  vi.mocked(whoami)
    .mockResolvedValueOnce({ principal: 'p-a' })
    .mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
  render(<App />);
  expect(await screen.findByText('p-a in space-a')).toBeTruthy();

  act(() => { expect(openSpace('space-b')).toBe(true); });
  expect(whoami).toHaveBeenLastCalledWith('space-b');
  // Until the new space answers, the old screen and its selection stay whole.
  expect(currentSite()).toBe('space-a');
  expect(screen.getByText('p-a in space-a')).toBeTruthy();

  await act(async () => { answer({ principal: 'p-b' }); });
  expect(await screen.findByText('p-b in space-b')).toBeTruthy();
  expect(currentSite()).toBe('space-b');
  expect(location.search).toBe('?site=space-b');
  expect(mounts).toHaveBeenCalledTimes(2);
});

it('the last of two quick switches wins', async () => {
  selectSite('space-a');
  const answers: ((me: { principal: string }) => void)[] = [];
  vi.mocked(whoami)
    .mockResolvedValueOnce({ principal: 'p-a' })
    .mockImplementation(() => new Promise(resolve => { answers.push(resolve); }));
  render(<App />);
  expect(await screen.findByText('p-a in space-a')).toBeTruthy();

  act(() => { openSpace('space-b'); openSpace('space-c'); });
  await act(async () => { answers[1]!({ principal: 'p-c' }); });
  await act(async () => { answers[0]!({ principal: 'p-b' }); });
  expect(await screen.findByText('p-c in space-c')).toBeTruthy();
  expect(currentSite()).toBe('space-c');
});

it('opening a file in the space already shown still remounts the drive to open it', async () => {
  selectSite('space-a');
  vi.mocked(whoami).mockResolvedValue({ principal: 'p-a' });
  render(<App />);
  expect(await screen.findByText('p-a in space-a')).toBeTruthy();

  await act(async () => { openSpaceFile('space-a', 'file-1'); });
  await waitFor(() => expect(mounts).toHaveBeenCalledTimes(2));
  expect(new URLSearchParams(location.search).get('file')).toBe('file-1');
});

it('re-asks about work that started while the new space answered, and stays put on a no', async () => {
  selectSite('space-a');
  let answer!: (me: { principal: string }) => void;
  vi.mocked(whoami)
    .mockResolvedValueOnce({ principal: 'p-a' })
    .mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
  const Draft = ({ active }: { active: boolean }) => { useNavigationGuard(active); return null; };
  const { rerender } = render(<><App /><Draft active={false} /></>);
  expect(await screen.findByText('p-a in space-a')).toBeTruthy();

  act(() => { openSpace('space-b'); });
  rerender(<><App /><Draft active /></>);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await act(async () => { answer({ principal: 'p-b' }); });
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  expect(currentSite()).toBe('space-a');
  expect(screen.getByText('p-a in space-a')).toBeTruthy();
  confirm.mockRestore();
});

it('a switch overtaken while its mirror resumes selects nothing, publishes nothing, changes no session', async () => {
  selectSite('space-a');
  vi.mocked(whoami).mockImplementation(async (slug?: string | null) => ({ principal: `p-${(slug ?? 'space-a').slice(-1)}` }));
  render(<App />);
  expect(await screen.findByText('p-a in space-a')).toBeTruthy();

  let resumeB!: () => void;
  vi.mocked(resumeMirror).mockImplementationOnce(() => new Promise<void>(resolve => { resumeB = resolve; }));
  act(() => { openSpace('space-b'); });
  await waitFor(() => expect(resumeMirror).toHaveBeenLastCalledWith('p-b'));
  vi.mocked(publishPlugins).mockClear();

  await act(async () => { openSpace('space-c'); });
  expect(await screen.findByText('p-c in space-c')).toBeTruthy();
  expect(publishPlugins).toHaveBeenCalledTimes(1);

  await act(async () => { resumeB(); });
  expect(currentSite()).toBe('space-c');
  expect(screen.getByText('p-c in space-c')).toBeTruthy();
  expect(publishPlugins).toHaveBeenCalledTimes(1);
});

it('an edit after leaving was approved is asked about again', () => {
  const Draft = () => { useNavigationGuard(true); return null; };
  render(<Draft />);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  expect(confirmNavigation()).toBe(true);
  expect(confirmNavigation()).toBe(true);
  expect(confirm).toHaveBeenCalledTimes(1);
  document.body.dispatchEvent(new Event('input', { bubbles: true }));
  confirm.mockReturnValue(false);
  expect(confirmNavigation()).toBe(false);
  expect(confirm).toHaveBeenCalledTimes(2);
  confirm.mockRestore();
});

it('new work without an edit event — a retried upload — is asked about again', () => {
  const Queue = ({ work }: { work: number }) => { useNavigationGuard(true, work); return null; };
  const { rerender } = render(<Queue work={1} />);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  expect(confirmNavigation()).toBe(true);
  rerender(<Queue work={2} />);
  confirm.mockReturnValue(false);
  expect(confirmNavigation()).toBe(false);
  expect(confirm).toHaveBeenCalledTimes(2);
  confirm.mockRestore();
});
