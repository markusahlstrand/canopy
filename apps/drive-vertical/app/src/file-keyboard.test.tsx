import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FileTable } from './file-table';
afterEach(cleanup);
const files = ['First', 'Second', 'Third'].map((name, i) => ({ id: String(i), name, kind: 'doc' as const, modified: '', size: '', isFolder: false }));
it.each(['list', 'grid'] as const)('navigates and selects loaded %s rows without hijacking child controls', view => {
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

it('keeps focus in the list when the focused row is removed, but leaves outside focus alone', () => {
  const props = { view: 'list' as const, selection: new Set<string>(), onSelectionChange: vi.fn(), onOpen: vi.fn(), sort: { key: 'name' as const, dir: 'asc' as const }, onSort: vi.fn(), onAction: vi.fn(), pluginMenuItems: () => [] };
  const result = render(<><button>Outside</button><FileTable {...props} files={files} /></>);
  act(() => result.container.querySelectorAll<HTMLElement>('[data-file-row]')[1]!.focus());
  result.rerender(<><button>Outside</button><FileTable {...props} files={[files[0]!, files[2]!]} /></>);
  expect(document.activeElement).toBe(result.container.querySelectorAll('[data-file-row]')[1]);
  act(() => screen.getByRole('button', { name: 'Outside' }).focus());
  result.rerender(<><button>Outside</button><FileTable {...props} files={[files[0]!]} /></>);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Outside' }));
});
it('steps vertically by rendered grid columns and does not restore trash with Enter', () => {
  const open = vi.fn(); const result = render(<FileTable files={files} view="grid" trashed selection={new Set()} onSelectionChange={() => {}} onOpen={open} sort={{ key: 'name', dir: 'asc' }} onSort={() => {}} onAction={() => {}} pluginMenuItems={() => []} />);
  const rows = result.container.querySelectorAll<HTMLElement>('[data-file-row]');
  rows.forEach((row, i) => { Object.defineProperty(row, 'offsetWidth', { value: 180 }); Object.defineProperty(row, 'offsetTop', { value: i < 2 ? 0 : 100 }); });
  act(() => rows[0]!.focus()); fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' }); expect(document.activeElement).toBe(rows[2]);
  fireEvent.keyDown(rows[2]!, { key: 'Enter' }); expect(open).not.toHaveBeenCalled();
});
it('uses the last keyboard toggle as the Shift-click range anchor', () => {
  function Harness() { const [selection, setSelection] = useState(new Set<string>()); return <FileTable files={files} view="list" selection={selection} onSelectionChange={setSelection} onOpen={() => {}} sort={{ key: 'name', dir: 'asc' }} onSort={() => {}} onAction={() => {}} pluginMenuItems={() => []} />; }
  const result = render(<Harness />); const rows = result.container.querySelectorAll<HTMLElement>('[data-file-row]');
  fireEvent.click(rows[0]!); fireEvent.keyDown(rows[0]!, { key: ' ' }); fireEvent.keyDown(rows[1]!, { key: ' ' }); fireEvent.click(rows[2]!, { shiftKey: true });
  expect([...rows].map(row => row.getAttribute('aria-selected'))).toEqual(['false', 'true', 'true']);
});
