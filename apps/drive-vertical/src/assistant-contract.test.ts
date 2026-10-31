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

it('keeps within a character budget, always sending the last question', () => {
  const turns = [
    { role: 'user' as const, content: 'q1' }, { role: 'assistant' as const, content: 'a'.repeat(10) },
    { role: 'user' as const, content: 'q2' }, { role: 'assistant' as const, content: 'b'.repeat(10) },
    { role: 'user' as const, content: 'q'.repeat(50) },
  ];
  expect(historyWindow(turns, 20).map(t => t.content)).toEqual(['q'.repeat(50)]);
  expect(historyWindow(turns, 64).map(t => t.content)).toEqual(['q2', 'b'.repeat(10), 'q'.repeat(50)]);
});
