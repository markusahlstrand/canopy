import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { formatJson, JsonPreview } from './json-format';
import { shapeOf } from './preview';
afterEach(cleanup);
it('formats whitespace while retaining large numbers, duplicate keys and escaped strings', () => {
  const text = '{"n":9007199254740993,"n":1e+100,"x":"a\\\"b\\n","empty":[]}';
  const formatted = formatJson(text);
  expect(formatted).toContain('9007199254740993'); expect(formatted).toContain('1e+100');
  expect(formatted.match(/"n"/g)).toHaveLength(2); expect(formatted).toContain('"a\\\"b\\n"');
  expect(JSON.parse(formatted)).toEqual(JSON.parse(text)); expect(formatted).toContain('\n');
});
it('rejects invalid, oversized and excessively nested JSON', () => {
  expect(() => formatJson('{bad}')).toThrow(); expect(() => formatJson('['.repeat(101) + '0' + ']'.repeat(101))).toThrow('deep');
  expect(() => formatJson(' '.repeat(512 * 1024 + 1))).toThrow('large');
});
it('toggles read-only formatting and returns exactly to original text, with safe failure fallback', () => {
  const text = '{"html":"<script>x</script>","n":9007199254740993}'; const view = render(<JsonPreview text={text} wrap onWrapChange={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Format JSON' })); expect(view.container.querySelector('pre')!.textContent).toBe(formatJson(text)); expect(view.container.querySelector('script')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Format JSON' })); expect(view.container.querySelector('pre')!.textContent).toBe(text);
  view.rerender(<JsonPreview text="invalid" wrap onWrapChange={() => {}} />); fireEvent.click(screen.getByRole('button', { name: 'Format JSON' }));
  expect(screen.getByRole('alert')).toBeTruthy(); expect(screen.getByRole('button', { name: 'Format JSON' }).getAttribute('aria-pressed')).toBe('false'); expect(view.container.querySelector('pre')!.textContent).toBe('invalid');
});

it('classifies JSON with MIME parameters and mixed case as text', () => {
  expect(shapeOf('Application/JSON; charset=utf-8')).toBe('text');
  expect(shapeOf('Application/LD+JSON; charset=utf-8')).toBe('text');
});
