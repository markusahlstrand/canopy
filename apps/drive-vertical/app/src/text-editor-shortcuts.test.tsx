import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TextEditor } from './text-editor';
import { TEXT_EDIT_LIMIT } from './api';
import { MAX_EDIT_CHARS } from '../../src/text-content';
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
it('uses the same limit and unit as the server', () => {
  expect(TEXT_EDIT_LIMIT).toBe(MAX_EDIT_CHARS);
});
it('saves non-Latin text the server accepts even when it exceeds the limit in UTF-8 bytes', async () => {
  const { fetcher, props, editor } = setup();
  const draft = '界'.repeat(Math.floor(TEXT_EDIT_LIMIT / 2)); // 100k characters, 300k UTF-8 bytes
  fireEvent.change(editor, { target: { value: draft } });
  expect(screen.queryByText(/exceeds the save limit/)).toBeNull();
  fireEvent.keyDown(editor, { key: 's', ctrlKey: true });
  await waitFor(() => expect(props.onSaved).toHaveBeenCalledOnce());
  expect(fetcher).toHaveBeenCalledOnce();
});
it('blocks save when the draft has more characters than the server accepts', () => {
  const { fetcher, editor } = setup(); fireEvent.change(editor, { target: { value: 'a'.repeat(TEXT_EDIT_LIMIT + 1) } });
  expect((screen.getByRole('button', { name: 'Save text' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('status').textContent).toContain('exceeds the save limit');
  fireEvent.keyDown(editor, { key: 's', ctrlKey: true }); expect(fetcher).not.toHaveBeenCalled();
});
it('keeps the editor focused while saving so a retry shortcut still reaches it', async () => {
  let fail!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { fail = resolve; })); vi.stubGlobal('fetch', fetcher);
  render(<TextEditor fileId="a" versionId="v1" text="original" onSaved={vi.fn(async () => {})} onReload={vi.fn(async () => {})} onCancel={vi.fn()} />);
  const editor = screen.getByRole('textbox', { name: 'File text' }) as HTMLTextAreaElement;
  fireEvent.change(editor, { target: { value: 'draft' } }); editor.focus();
  fireEvent.keyDown(editor, { key: 's', ctrlKey: true });
  await waitFor(() => expect(editor.readOnly).toBe(true));
  expect(editor.disabled).toBe(false); expect(document.activeElement).toBe(editor);
  fail(new Response('nope', { status: 500 })); await screen.findByRole('alert');
  expect(editor.readOnly).toBe(false); expect(document.activeElement).toBe(editor);
  const retry = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
  fireEvent(editor, retry); expect(retry.defaultPrevented).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
