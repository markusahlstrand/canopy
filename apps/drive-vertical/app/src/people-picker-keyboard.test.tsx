import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PeoplePicker } from './people-picker';

afterEach(cleanup);
const people = [{ principal: 'alice', name: 'Alice', email: 'alice@example.com', seen_at: '' }];

it('does not choose a person while Enter confirms composed text', async () => {
  const pick = vi.fn();
  render(<PeoplePicker value="Ali" people={people} onChange={() => {}} onPick={pick} />);
  await screen.findByRole('option');
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', isComposing: true });
  expect(pick).not.toHaveBeenCalled();
  expect(screen.getByRole('listbox')).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
  expect(pick).toHaveBeenCalledExactlyOnceWith(people[0]);
});

it('uses Escape to close suggestions without closing the surrounding dialog', async () => {
  const parentKey = vi.fn();
  render(<div onKeyDown={parentKey}><PeoplePicker value="Ali" people={people} onChange={() => {}} onPick={() => {}} /></div>);
  await screen.findByRole('listbox');
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  fireEvent(screen.getByRole('combobox'), event);
  expect(event.defaultPrevented).toBe(true);
  expect(parentKey).not.toHaveBeenCalled();
  expect(screen.queryByRole('listbox')).toBeNull();
  expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('Ali');
});
