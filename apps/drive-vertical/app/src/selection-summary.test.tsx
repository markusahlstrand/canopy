import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SelectionSummary } from './selection-summary';
afterEach(cleanup);
it('counts files and folders once, reports selections missing from the loaded page, and clears explicitly', () => {
  const clear = vi.fn(); const items = [{ id: 'file', isFolder: false }, { id: 'file', isFolder: false }, { id: 'folder', isFolder: true }];
  const view = render(<SelectionSummary items={items} selection={new Set(['file', 'folder', 'gone'])} onClear={clear} />);
  expect(screen.getByRole('status').textContent).toContain('3 items selected: 1 file, 1 folder');
  expect(screen.getByRole('status').textContent).toContain('1 selected item is not on this loaded page');
  fireEvent.click(screen.getByRole('button', { name: 'Clear selection' })); expect(clear).toHaveBeenCalledOnce();
  view.rerender(<SelectionSummary items={items} selection={new Set()} onClear={clear} />); expect(screen.queryByRole('region')).toBeNull();
});
