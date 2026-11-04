import 'fake-indexeddb/auto';
import { useEffect } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import App from './App';
import { currentSite, selectSite, whoami } from './api';
import { openSpace } from './space-navigation';

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
