import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ShareDialog } from './share-dialog';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('hides the previous folder grants while the next folder is loading', async () => {
  let finishNext!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/folders/a/shares')) return Promise.resolve(new Response(JSON.stringify({ shares: [{
      folder_id: 'a', principal: 'alice', permission: 'drive:write', granted_at: '', granted_by: '',
      name: 'Alice', email: null,
    }] })));
    if (path.endsWith('/folders/b/shares')) return new Promise<Response>(resolve => { finishNext = resolve; });
    if (path.endsWith('/people')) return Promise.resolve(new Response(JSON.stringify({ people: [] })));
    return Promise.resolve(new Response(JSON.stringify({ id: path.includes('/folders/b') ? 'b' : 'a', path: 'Folder' })));
  }));

  const view = render(<ShareDialog folder={{ id: 'a', name: 'A' }} onClose={() => {}} />);
  expect(await screen.findByText('Alice')).toBeTruthy();
  view.rerender(<ShareDialog folder={{ id: 'b', name: 'B' }} onClose={() => {}} />);
  expect(screen.queryByText('Alice')).toBeNull();
  expect(screen.getByText('Loading…')).toBeTruthy();
  await act(async () => finishNext(new Response(JSON.stringify({ shares: [] }))));
  expect(screen.queryByText('Alice')).toBeNull();
});
