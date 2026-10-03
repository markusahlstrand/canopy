import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FileTable } from './file-table';
afterEach(cleanup);
it.each(['list', 'grid'] as const)('highlights actual name and content matches in %s results', view => {
  const { container } = render(<FileTable files={[{ id: '1', name: 'Report portfolio', description: 'Annual port for a plan', snippet: 'Annual port for a plan', kind: 'doc', modified: '', size: '', isFolder: false }, { id: '2', name: '<script>File', description: 'Matched in the name', kind: 'doc', modified: '', size: '', isFolder: false }]} searchQuery="a port" view={view} selection={new Set()} onSelectionChange={() => {}} onOpen={() => {}} sort={{ key: 'name', dir: 'asc' }} onSort={() => {}} onAction={() => {}} pluginMenuItems={() => []} />);
  expect([...container.querySelectorAll('mark')].map(mark => mark.textContent)).toEqual(['port', 'port']);
  expect(screen.getByText('Matched in the name').querySelector('mark')).toBeNull();
  expect(container.querySelector('script')).toBeNull();
  expect(container.textContent).toContain('<script>File');
});
