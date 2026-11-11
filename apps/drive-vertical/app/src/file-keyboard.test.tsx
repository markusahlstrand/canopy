import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fileRows } from './test-table';
import { FileTable } from './file-table';
afterEach(cleanup);
const files = ['First', 'Second', 'Third'].map((name, i) => ({ id: String(i), name, kind: 'doc' as const, modified: '', size: '', isFolder: false }));
it('navigates and selects loaded grid cards without hijacking child controls', () => {
  const view = 'grid' as const;
  const open = vi.fn();
  function Harness() { const [selection, setSelection] = useState(new Set<string>()); return <><output aria-label="Selected">{[...selection].join(',')}</output><FileTable files={files} view={view} selection={selection} onSelectionChange={setSelection} onOpen={open} sort={{ key: 'name', dir: 'asc' }} onSort={() => {}} onAction={() => {}} pluginMenuItems={() => []} /></>; }
  const result = render(<Harness />); const rows = result.container.querySelectorAll<HTMLElement>('[data-file-row]');
  expect([...rows].map(row => row.tabIndex)).toEqual([0, -1, -1]); rows[0]!.focus();
  fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' }); expect(document.activeElement).toBe(rows[1]);
  fireEvent.keyDown(rows[1]!, { key: ' ' }); expect(screen.getByLabelText('Selected').textContent).toBe('1'); expect(rows[1]!.getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(rows[1]!, { key: 'Enter' }); expect(open).toHaveBeenCalledExactlyOnceWith(files[1]);
  fireEvent.keyDown(rows[1]!, { key: 'End' }); expect(document.activeElement).toBe(rows[2]);
  fireEvent.keyDown(rows[2]!, { key: 'Home' }); expect(document.activeElement).toBe(rows[0]);
  fireEvent.keyDown(rows[0]!, { key: 'a', ctrlKey: true }); expect(screen.getByLabelText('Selected').textContent).toBe('0,1,2');
  fireEvent.keyDown(screen.getByRole('button', { name: 'Actions for First' }), { key: 'Enter' }); expect(open).toHaveBeenCalledOnce();
});

it('steps vertically by rendered grid columns and does not restore trash with Enter', () => {
  const open = vi.fn(); const result = render(<FileTable files={files} view="grid" trashed selection={new Set()} onSelectionChange={() => {}} onOpen={open} sort={{ key: 'name', dir: 'asc' }} onSort={() => {}} onAction={() => {}} pluginMenuItems={() => []} />);
  const rows = result.container.querySelectorAll<HTMLElement>('[data-file-row]');
  rows.forEach((row, i) => { Object.defineProperty(row, 'offsetWidth', { value: 180 }); Object.defineProperty(row, 'offsetTop', { value: i < 2 ? 0 : 100 }); });
  act(() => rows[0]!.focus()); fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' }); expect(document.activeElement).toBe(rows[2]);
  fireEvent.keyDown(rows[2]!, { key: 'Enter' }); expect(open).not.toHaveBeenCalled();
});
/** The list is `<sub-entity-table>`: its keys are the element's, and these check the wiring. */
const focused = () => document.querySelector('sub-entity-table')!.shadowRoot!.activeElement;
const listProps = { view: 'list' as const, sort: { key: 'name' as const, dir: 'asc' as const }, onSort: () => {}, onAction: () => {}, pluginMenuItems: () => [] };

it('navigates, selects and opens list rows through the entity table', async () => {
  const open = vi.fn();
  function Harness() { const [selection, setSelection] = useState(new Set<string>()); return <><output aria-label="Selected">{[...selection].join(',')}</output><FileTable {...listProps} files={files} selection={selection} onSelectionChange={setSelection} onOpen={open} /></>; }
  render(<Harness />);
  await waitFor(() => expect(fileRows()).toHaveLength(3));
  const rows = fileRows();
  expect(rows.map(row => row.tabIndex)).toEqual([0, -1, -1]);
  act(() => rows[0]!.focus());
  fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' }); await waitFor(() => expect(focused()).toBe(fileRows()[1]));
  fireEvent.keyDown(fileRows()[1]!, { key: ' ' }); await waitFor(() => expect(screen.getByLabelText('Selected').textContent).toBe('1'));
  fireEvent.keyDown(fileRows()[1]!, { key: 'Enter' }); expect(open).toHaveBeenCalledExactlyOnceWith(files[1]);
  fireEvent.keyDown(fileRows()[1]!, { key: 'a', ctrlKey: true }); await waitFor(() => expect(screen.getByLabelText('Selected').textContent).toBe('0,1,2'));
  // A key on a control inside a row is that control's, not the row's.
  fireEvent.keyDown(screen.getByRole('button', { name: 'Actions for First' }), { key: 'Enter' }); expect(open).toHaveBeenCalledOnce();
});

it('keeps focus in the list when the focused row is removed', async () => {
  const props = { ...listProps, selection: new Set<string>(), onSelectionChange: vi.fn(), onOpen: vi.fn() };
  const result = render(<FileTable {...props} files={files} />);
  await waitFor(() => expect(fileRows()).toHaveLength(3));
  act(() => fileRows()[1]!.focus());
  result.rerender(<FileTable {...props} files={[files[0]!, files[2]!]} />);
  await waitFor(() => expect(fileRows()).toHaveLength(2));
  await waitFor(() => expect(focused()).toBe(fileRows()[1]));
});

it('restores a trashed row on a double-click but not on Enter', async () => {
  const open = vi.fn();
  render(<FileTable {...listProps} trashed files={files} selection={new Set()} onSelectionChange={() => {}} onOpen={open} />);
  await waitFor(() => expect(fileRows()).toHaveLength(3));
  act(() => fileRows()[0]!.focus());
  fireEvent.keyDown(fileRows()[0]!, { key: 'Enter' }); fireEvent.keyUp(fileRows()[0]!, { key: 'Enter' });
  expect(open).not.toHaveBeenCalled();
  fireEvent.doubleClick(screen.getByText('First'));
  expect(open).toHaveBeenCalledExactlyOnceWith(files[0]);
});
