import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CurrentFolderShare } from './current-folder-share';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('opens the current folder only when the server permits management', async () => {
  const pending: ((response: Response) => void)[] = [];
  vi.stubGlobal('fetch', () => new Promise(resolve => { pending.push(resolve as (response: Response) => void); }));
  const onShare = vi.fn();
  const view = render(<CurrentFolderShare folderId="a" onShare={onShare} />);
  expect(screen.queryByRole('button')).toBeNull();
  await act(async () => pending[0]!(new Response(JSON.stringify({ id: 'a', name: 'Papers', canManage: true }))));
  fireEvent.click(screen.getByRole('button', { name: 'Share this folder' }));
  expect(onShare).toHaveBeenCalledWith({ id: 'a', name: 'Papers' });
  view.rerender(<CurrentFolderShare folderId="b" onShare={onShare} />);
  expect(screen.queryByRole('button')).toBeNull();
  await act(async () => pending[1]!(new Response(JSON.stringify({ id: 'b', name: 'Private', canManage: false }))));
  expect(screen.queryByRole('button')).toBeNull();
});
it('ignores a late permission response from a folder that was left', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(new Response(JSON.stringify({ id: 'b', canManage: false }))));
  const view = render(<CurrentFolderShare folderId="a" onShare={() => {}} />);
  view.rerender(<CurrentFolderShare folderId="b" onShare={() => {}} />);
  await act(async () => { finish(new Response(JSON.stringify({ id: 'a', canManage: true }))); });
  expect(screen.queryByRole('button')).toBeNull();
});

it('never offers or fetches root sharing', () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  render(<CurrentFolderShare folderId="root" onShare={() => {}} />);
  expect(screen.queryByRole('button')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
