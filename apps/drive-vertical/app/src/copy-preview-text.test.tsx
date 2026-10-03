import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TextPreview } from './text-preview';
import { PreviewPanel } from './preview';
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
it('announces partial copies in a persistent status region and keeps keyboard focus', async () => {
  let finish!: () => void;
  const writeText = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const view = render(<TextPreview text={'x'.repeat(200000)} truncated wrap onWrapChange={() => {}} />);
  const button = screen.getByRole('button', { name: 'Copy loaded text' });
  const region = view.container.querySelector('span[role="status"]')!;
  expect(region.textContent).toBe(''); button.focus(); fireEvent.click(button);
  expect(document.activeElement).toBe(button); expect(button.hasAttribute('disabled')).toBe(false);
  expect(button.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(button); expect(writeText).toHaveBeenCalledOnce();
  await act(async () => finish());
  expect(view.container.querySelector('span[role="status"]')).toBe(region);
  expect(region.textContent).toContain('first 200,000 characters');
  expect(region.textContent).toContain('download it for the rest');
  expect(writeText).toHaveBeenCalledExactlyOnceWith('x'.repeat(200000));
});

it('passes API body truncation into the copy toolbar', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(url.includes('/content') ? 'x'.repeat(200001) : JSON.stringify({ file: { id: 'f', name: 'large.txt' }, version: { id: 'v', source: 'blob', mime: 'text/plain' }, canWrite: false }))));
  render(<PreviewPanel fileId="f" onClose={() => {}} onError={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Copy loaded text' }));
  await screen.findByText(/Copied the first 200,000 characters/);
  expect(writeText).toHaveBeenCalledExactlyOnceWith('x'.repeat(200000));
});
