import 'fake-indexeddb/auto';
import { useEffect } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { currentSite, selectSite, whoami } from './api';
import { openSpace, openSpaceFile } from './space-navigation';
import { useNavigationGuard } from './navigation-guards';

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
  expect(location.search).toBe('');
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
