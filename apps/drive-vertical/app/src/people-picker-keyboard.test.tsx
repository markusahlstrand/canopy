import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PeoplePicker } from './people-picker';
import { ShareDialog } from './share-dialog';
import * as api from './api';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
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

it('does not choose a person when WebKit ends composition before the confirming Enter', async () => {
  const pick = vi.fn();
  render(<PeoplePicker value="Ali" people={people} onChange={() => {}} onPick={pick} />);
  await screen.findByRole('option');
  const input = screen.getByRole('combobox');
  fireEvent.compositionStart(input);
  fireEvent.compositionEnd(input, { data: 'Ali' });
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: false });
  expect(pick).not.toHaveBeenCalled();
  expect(screen.getByRole('listbox')).toBeTruthy();
  fireEvent.keyDown(input, { key: 'Enter' });
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

it('keeps the Radix sharing dialog open until suggestions have been dismissed', async () => {
  vi.spyOn(api, 'listPeople').mockResolvedValue({ people });
  vi.spyOn(api, 'listFolderShares').mockResolvedValue({ shares: [] });
  vi.spyOn(api, 'getFolder').mockResolvedValue({ id: 'folder', name: 'Folder', path: 'Folder', parent_id: 'root', canManage: true });
  vi.spyOn(api, 'listSites').mockResolvedValue([{ slug: 'family', name: 'Family', current: true }]);
  const close = vi.fn();
  render(<ShareDialog folder={{ id: 'folder', name: 'Folder' }} onClose={close} />);
  await screen.findByText(/Nobody yet/);
  const input = screen.getByRole('combobox', { name: 'Person' });
  fireEvent.change(input, { target: { value: 'Ali' } });
  await screen.findByRole('listbox');
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(close).not.toHaveBeenCalled();
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(close).toHaveBeenCalledOnce();
});
