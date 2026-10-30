import { expect, it } from 'vitest';
import { historyWindow, MAX_MESSAGES } from './assistant-contract';

it('sends the latest turns that fit, starting on a question', () => {
  const turns = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: String(i) }));
  const window = historyWindow(turns);
  expect(window.length).toBeLessThanOrEqual(MAX_MESSAGES);
  expect(window[0]!.role).toBe('user');
  expect(window.at(-1)).toEqual(turns.at(-1));
  expect(historyWindow(turns.slice(0, 3))).toEqual(turns.slice(0, 3));
});
