import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TextEditor } from './text-editor';
import { TEXT_PREVIEW_LIMIT } from './api';
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup(response: Response = new Response('{}', { status: 201 })) {
  const fetcher = vi.fn(async () => response); vi.stubGlobal('fetch', fetcher);
  const props = { fileId: 'a', versionId: 'v1', text: 'original', onSaved: vi.fn(async () => {}), onReload: vi.fn(async () => {}), onCancel: vi.fn() };
  render(<TextEditor {...props} />); return { fetcher, props, editor: screen.getByRole('textbox', { name: 'File text' }) };
}
it.each(['ctrlKey', 'metaKey'])('saves through %s+S and prevents the browser save action', async modifier => {
  const { fetcher, props, editor } = setup(); fireEvent.change(editor, { target: { value: 'draft' } });
  const event = new KeyboardEvent('keydown', { key: 's', [modifier]: true, bubbles: true, cancelable: true });
  fireEvent(editor, event); expect(event.defaultPrevented).toBe(true);
  await waitFor(() => expect(props.onSaved).toHaveBeenCalledOnce());
  expect(fetcher).toHaveBeenCalledWith('/api/files/a/content?expectedVersion=v1', expect.objectContaining({ body: 'draft', method: 'PUT' }));
});
it('does not save unchanged, repeating, composing or conflicting drafts through a shortcut', async () => {
  const { fetcher, editor } = setup(new Response('Conflict', { status: 409 }));
  fireEvent.keyDown(editor, { key: 's', ctrlKey: true }); expect(fetcher).not.toHaveBeenCalled();
  fireEvent.change(editor, { target: { value: 'draft' } });
  fireEvent.keyDown(editor, { key: 's', ctrlKey: true, repeat: true });
  fireEvent.keyDown(editor, { key: 's', ctrlKey: true, isComposing: true }); expect(fetcher).not.toHaveBeenCalled();
  fireEvent.keyDown(editor, { key: 's', ctrlKey: true }); await screen.findByRole('alert');
  fireEvent.keyDown(editor, { key: 's', ctrlKey: true }); expect(fetcher).toHaveBeenCalledOnce();
});
it('confirms before Escape discards a draft and lets the user keep it', () => {
  const { props, editor } = setup(); const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  fireEvent.change(editor, { target: { value: 'draft' } }); fireEvent.keyDown(editor, { key: 'Escape' });
  expect(props.onCancel).not.toHaveBeenCalled(); expect(screen.getByDisplayValue('draft')).toBeTruthy();
  confirm.mockReturnValue(true); fireEvent.keyDown(editor, { key: 'Escape' }); expect(props.onCancel).toHaveBeenCalledOnce();
});
it('counts UTF-8 bytes and blocks save when a multibyte draft exceeds the byte limit', () => {
  const { fetcher, editor } = setup(); fireEvent.change(editor, { target: { value: '界'.repeat(Math.floor(TEXT_PREVIEW_LIMIT / 3) + 1) } });
  expect((screen.getByRole('button', { name: 'Save text' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('status').textContent).toContain('exceeds the save limit');
  fireEvent.keyDown(editor, { key: 's', ctrlKey: true }); expect(fetcher).not.toHaveBeenCalled();
});
