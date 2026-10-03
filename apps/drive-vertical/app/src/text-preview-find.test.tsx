import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TextPreview } from './text-preview';
afterEach(cleanup);
const props = { wrap: true, onWrapChange: () => {} };
const find = (query: string) => fireEvent.change(screen.getByRole('searchbox', { name: 'Find in file' }), { target: { value: query } });
it('finds literal case-insensitive matches, wraps navigation, and preserves the original text', () => {
  const text = 'A.b aXb A.B <script>unsafe()</script>';
  const { container } = render(<TextPreview {...props} text={text} />); find('a.b');
  expect(screen.getByRole('status').textContent).toBe('1 of 2 matches');
  expect(container.querySelectorAll('mark')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Previous match' }));
  expect(screen.getByRole('status').textContent).toBe('2 of 2 matches');
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' });
  expect(screen.getByRole('status').textContent).toBe('1 of 2 matches');
  expect(container.querySelector('pre')!.textContent).toBe(text); expect(container.querySelector('script')).toBeNull();
});
it('handles Unicode indices and no-match/clear states without changing wrapping', () => {
  const text = 'İ i 😀 END'; const { container } = render(<TextPreview {...props} text={text} />);
  find('end'); expect(container.querySelector('mark')!.textContent).toBe('END');
  find('missing'); expect(screen.getByRole('status').textContent).toBe('No matches');
  expect((screen.getByRole('button', { name: 'Next match' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
  expect(screen.queryByRole('status')).toBeNull(); expect(container.querySelector('pre')!.textContent).toBe(text);
  expect(screen.getByRole('button', { name: 'Wrap lines' }).getAttribute('aria-pressed')).toBe('true');
});
it('caps highlight nodes in repetitive files and resets navigation when text changes', () => {
  const view = render(<TextPreview {...props} text={'a '.repeat(1100)} />); find('a');
  expect(view.container.querySelectorAll('mark')).toHaveLength(1000);
  expect(screen.getByRole('status').textContent).toContain('first 1,000');
  fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
  view.rerender(<TextPreview {...props} text="a" />);
  expect(screen.getByRole('status').textContent).toBe('1 of 1 matches');
});
