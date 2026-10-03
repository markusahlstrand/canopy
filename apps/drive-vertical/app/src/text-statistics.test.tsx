import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { textStatistics } from './text-statistics';
import { TextPreview } from './text-preview';
import { PreviewPanel } from './preview';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('counts UTF-16 units and logical lines without changing whitespace', () => {
  expect(textStatistics('')).toEqual({ characters: 0, words: 0, lines: 0 });
  expect(textStatistics('🙂a\r\nb')).toEqual({ characters: 6, words: 2, lines: 2 });
  expect(textStatistics('a\n\n').lines).toBe(2);
  expect(textStatistics('漢字').characters).toBe(2);
});
it('labels statistics as displayed-preview counts and updates them with the text', () => {
  const view = render(<TextPreview text="one two" wrap onWrapChange={() => {}} />);
  expect(screen.getByText(/Displayed text:/).textContent).toContain('2 words');
  view.rerender(<TextPreview text="one" wrap onWrapChange={() => {}} />);
  expect(screen.getByText(/Displayed text:/).textContent).toContain('3 characters');
  expect(view.container.querySelector('pre')!.textContent).toBe('one');
});

it.each(['a\n', 'a\r', 'a\r\n', '\n'])('does not add a displayed line for the final terminator: %j', text => {
  expect(textStatistics(text).lines).toBe(1);
});
it('omits expensive word segmentation for large previews', () => {
  const segment = vi.spyOn(Intl.Segmenter.prototype, 'segment');
  expect(textStatistics('漢'.repeat(20001)).words).toBeNull();
  expect(segment).not.toHaveBeenCalled(); segment.mockRestore();
});
it('marks real truncated API bodies as partial at the toolbar', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(url.includes('/content') ? 'x'.repeat(200001) : JSON.stringify({ file: { id: 'f', name: 'large.txt' }, version: { id: 'v', source: 'blob', mime: 'text/plain' }, canWrite: false }))));
  render(<PreviewPanel fileId="f" onClose={() => {}} onError={() => {}} />);
  const label = await screen.findByText(/Partial preview counts/);
  expect(label.textContent).toContain('the file is longer');
  expect(label.textContent).toContain('200,000 characters');
  expect(label.textContent).toContain('Word count omitted');
});
