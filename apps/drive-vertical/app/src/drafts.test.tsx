import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PreviewPanel } from './preview';
import { TextEditor } from './text-editor';
import { confirmDiscardDrafts } from './drafts';
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('protects a dirty draft on cancel and browser exit, then cleans up on unmount', () => {
  const cancel = vi.fn();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const view = render(<TextEditor fileId="file" versionId="v1" text="old" onSaved={async () => {}} onReload={async () => {}} onCancel={cancel} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'draft' } });
  const exit = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(exit);
  expect(exit.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }));
  expect(cancel).not.toHaveBeenCalled();
  expect(confirm).toHaveBeenCalledOnce();
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }));
  expect(cancel).toHaveBeenCalledOnce();
  view.unmount();
  expect(confirmDiscardDrafts()).toBe(true);
  const cleanExit = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(cleanExit);
  expect(cleanExit.defaultPrevented).toBe(false);
});
it('does not prompt for unchanged text', () => {
  const confirm = vi.spyOn(window, 'confirm');
  const cancel = vi.fn();
  render(<TextEditor fileId="file" versionId="v1" text="old" onSaved={async () => {}} onReload={async () => {}} onCancel={cancel} />);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }));
  expect(cancel).toHaveBeenCalledOnce();
  expect(confirm).not.toHaveBeenCalled();
});

it('keeps a metadata draft mounted when leaving its preview tab is declined', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(url.endsWith('/details')
    ? { fileId: 'file', description: 'old', labels: [], revision: 0, canWrite: true }
    : { file: { id: 'file', name: 'document' }, version: null })));
  render(<PreviewPanel fileId="file" onClose={() => {}} onError={() => {}} />);
  await screen.findByText('document');
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  await screen.findByDisplayValue('old');
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Versions' }));
  expect(screen.getByDisplayValue('draft')).toBeTruthy();
});
