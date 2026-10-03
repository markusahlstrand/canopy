import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { textStatistics } from './text-statistics';
import { TextPreview } from './text-preview';
afterEach(cleanup);
it('counts Unicode code points and logical lines without changing whitespace', () => {
  expect(textStatistics('')).toEqual({ characters: 0, words: 0, lines: 0 });
  expect(textStatistics('🙂a\r\nb')).toEqual({ characters: 5, words: 2, lines: 2 });
  expect(textStatistics('a\n\n').lines).toBe(3);
  expect(textStatistics('漢字').characters).toBe(2);
});
it('labels statistics as displayed-preview counts and updates them with the text', () => {
  const view = render(<TextPreview text="one two" wrap onWrapChange={() => {}} />);
  expect(screen.getByLabelText('Displayed text statistics').textContent).toContain('2 words');
  view.rerender(<TextPreview text="one" wrap onWrapChange={() => {}} />);
  expect(screen.getByLabelText('Displayed text statistics').textContent).toContain('3 characters');
  expect(view.container.querySelector('pre')!.textContent).toBe('one');
});
