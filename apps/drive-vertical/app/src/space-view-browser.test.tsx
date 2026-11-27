import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SpaceViewBrowser, LEAF_PAGE } from './space-view-browser';
import type { ViewFile } from './space-views';

afterEach(cleanup);

const many: ViewFile[] = Array.from({ length: LEAF_PAGE + 50 }, (_, i) => ({
  id: `f${String(i).padStart(4, '0')}`, name: `doc-${String(i).padStart(4, '0')}.pdf`, folder_path: '', labels: [],
  category: 'invoice', category_source: 'person', mime: 'application/pdf', created_at: '2026-01-01T00:00:00.000Z',
}));

it('mounts a big group a page at a time, and the rest on request', () => {
  render(<SpaceViewBrowser view={{ id: 'v', name: 'By category', groupBy: ['category'] }} files={many}
    categories={[{ id: 'invoice', name: 'Invoices' }]} path={['invoice']} onPath={() => {}}
    toRow={rows => rows.map(f => ({ id: f.id, name: f.name, kind: 'pdf' as const, modified: '', size: '', isFolder: false, category: '', labels: [] }))}
    onOpen={() => {}} loading={false} more={false} sort={{ key: 'name', dir: 'asc' }} onSort={() => {}} />);
  expect(screen.getAllByRole('row')).toHaveLength(LEAF_PAGE + 1);
  expect(screen.getByText(`Showing ${LEAF_PAGE} of ${LEAF_PAGE + 50}.`)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Show 50 more' }));
  expect(screen.getAllByRole('row')).toHaveLength(LEAF_PAGE + 50 + 1);
  expect(screen.queryByRole('button', { name: /more$/ })).toBeNull();
});
