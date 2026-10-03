import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TextPreview } from './text-preview';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('copies the literal displayed text and reports clipboard refusal without changing it', async () => {
  const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Denied'));
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const text = '<script>literal</script>\n 中文'; const view = render(<TextPreview text={text} wrap onWrapChange={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Copy displayed text' })); await screen.findByText('Displayed text copied.');
  expect(writeText).toHaveBeenCalledExactlyOnceWith(text);
  fireEvent.click(screen.getByRole('button', { name: 'Copy displayed text' })); await screen.findByText(/Could not copy/);
  expect(view.container.querySelector('pre')!.textContent).toBe(text); expect(view.container.querySelector('script')).toBeNull();
});
it('retires a pending outcome when another text replaces the preview', async () => {
  let finish!: () => void; const writeText = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const view = render(<TextPreview text="first" wrap onWrapChange={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Copy displayed text' }));
  view.rerender(<TextPreview text="second" wrap onWrapChange={() => {}} />);
  await act(async () => finish()); expect(screen.queryByText('Displayed text copied.')).toBeNull();
  expect(screen.getByRole('button', { name: 'Copy displayed text' }).hasAttribute('disabled')).toBe(false);
});
