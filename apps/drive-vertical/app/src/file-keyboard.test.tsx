import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FileTable } from './file-table';
afterEach(cleanup);
const files = ['First', 'Second', 'Third'].map((name, i) => ({ id: String(i), name, kind: 'doc' as const, modified: '', size: '', isFolder: false }));
it.each(['list', 'grid'] as const)('navigates and selects loaded %s rows without hijacking child controls', view => {
  const open = vi.fn();
  function Harness() { const [selection, setSelection] = useState(new Set<string>()); return <><output aria-label="Selected">{[...selection].join(',')}</output><FileTable files={files} view={view} selection={selection} onSelectionChange={setSelection} onOpen={open} sort={{ key: 'name', dir: 'asc' }} onSort={() => {}} onAction={() => {}} pluginMenuItems={() => []} /></>; }
  const result = render(<Harness />); const rows = result.container.querySelectorAll<HTMLElement>('[data-file-row]');
  expect([...rows].map(row => row.tabIndex)).toEqual([0, -1, -1]); rows[0]!.focus();
  fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' }); expect(document.activeElement).toBe(rows[1]);
  fireEvent.keyDown(rows[1]!, { key: ' ' }); expect(screen.getByLabelText('Selected').textContent).toBe('1');
  fireEvent.keyDown(rows[1]!, { key: 'Enter' }); expect(open).toHaveBeenCalledExactlyOnceWith(files[1]);
  fireEvent.keyDown(rows[1]!, { key: 'End' }); expect(document.activeElement).toBe(rows[2]);
  fireEvent.keyDown(rows[2]!, { key: 'Home' }); expect(document.activeElement).toBe(rows[0]);
  fireEvent.keyDown(rows[0]!, { key: 'a', ctrlKey: true }); expect(screen.getByLabelText('Selected').textContent).toBe('0,1,2');
  fireEvent.keyDown(screen.getByRole('button', { name: 'Actions for First' }), { key: 'Enter' }); expect(open).toHaveBeenCalledOnce();
});
