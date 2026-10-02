import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CommentsPanel } from './comments';

const comment = { id: '01A', file_id: 'file', author: 'ada', authorLabel: 'Ada', body: 'Existing', created_at: '2026-10-01T00:00:00Z', deleted_at: null, canDelete: false };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mockComments(fail = false, paging = false) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      if (fail) return new Response(JSON.stringify({ detail: 'Post refused' }), { status: 403 });
      return new Response(JSON.stringify({ ...comment, id: '01C', body: JSON.parse(init.body as string).body, canDelete: true }));
    }
    if (init?.method === 'DELETE') return new Response('{}');
    if (url.includes('cursor=')) return new Response(JSON.stringify([{ ...comment, id: '01B', body: 'Older page' }]));
    return new Response(JSON.stringify([comment]), { headers: paging ? { Link: `<${window.location.origin}/api/files/file/comments?cursor=01A>; rel="next"` } : {} });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('preview comment threads', () => {
  it('posts plain text and confirms deletion of an own comment', async () => {
    const fetch = mockComments();
    render(<CommentsPanel fileId="file" />);
    await screen.findByText('Existing');
    expect(screen.queryByRole('button', { name: 'Delete comment' })).toBeNull();
    fireEvent.change(screen.getByLabelText('New comment'), { target: { value: '<b>plain text</b>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    await screen.findByText('<b>plain text</b>');
    expect((screen.getByLabelText('New comment') as HTMLTextAreaElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Delete comment' }));
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(screen.queryByText('<b>plain text</b>')).toBeNull());
    expect(fetch).toHaveBeenCalledWith('/api/files/file/comments/01C', expect.objectContaining({ method: 'DELETE' }));
  });

  it('preserves the draft when posting is refused', async () => {
    mockComments(true);
    render(<CommentsPanel fileId="file" />);
    await screen.findByText('Existing');
    fireEvent.change(screen.getByLabelText('New comment'), { target: { value: 'My draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post comment' }));
    await screen.findByRole('alert');
    expect((screen.getByLabelText('New comment') as HTMLTextAreaElement).value).toBe('My draft');
    expect((screen.getByRole('button', { name: 'Post comment' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('appends another comment page and keeps the existing thread', async () => {
    mockComments(false, true);
    render(<CommentsPanel fileId="file" />);
    await screen.findByText('Existing');
    fireEvent.click(screen.getByRole('button', { name: 'Load more comments' }));
    await screen.findByText('Older page');
    expect(screen.getByText('Existing')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more comments' })).toBeNull();
  });
});
