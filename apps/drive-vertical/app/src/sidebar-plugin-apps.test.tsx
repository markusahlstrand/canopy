import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Sidebar } from './sidebar';
import type { PluginInstall } from './api';

afterEach(() => { cleanup(); localStorage.clear(); });

it('launches a plugin detail view from the space rail', () => {
  const row: PluginInstall = { id: 'install-1', plugin_id: 'notes', principal: 'space', enabled: 1, updated_at: 'now', manifest_json: JSON.stringify({ id: 'notes', name: 'Notes', version: '1', capabilities: [], contributes: { detailView: { id: 'notes', title: 'Notes app' } } }) };
  const onOpenPlugin = vi.fn();
  render(<Sidebar active={null} onNavigate={vi.fn()} onNewFolder={vi.fn()} onUpload={vi.fn()} sites={[]} failed={false} onRetry={vi.fn()} pluginApps={[row]} activePluginId={row.id} onOpenPlugin={onOpenPlugin} />);
  const launcher = screen.getByRole('button', { name: 'Notes app' });
  expect(launcher.getAttribute('aria-current')).toBe('page');
  fireEvent.click(launcher);
  expect(onOpenPlugin).toHaveBeenCalledWith('install-1');
});
it('filters a long space roster by name or slug, keeping the current space', () => {
  const sites = [
    {slug:'family',name:'Family',current:true},
    {slug:'work',name:'Team',current:false},
    ...['alpha','beta','gamma','delta'].map(slug => ({slug,name:slug,current:false})),
  ];
  render(<Sidebar active="drive" onNavigate={vi.fn()} onNewFolder={vi.fn()} onUpload={vi.fn()} sites={sites} failed={false} onRetry={vi.fn()} />);
  fireEvent.change(screen.getByRole('textbox', {name:'Filter spaces'}), {target:{value:'work'}});
  expect(screen.getByRole('button', {name:'Team'})).toBeTruthy();
  expect(screen.getByRole('button', {name:'Family'})).toBeTruthy();
  expect(screen.queryByRole('button', {name:'alpha'})).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
  fireEvent.change(screen.getByRole('textbox', {name:'Filter spaces'}), {target:{value:'absent'}});
  expect(screen.getByRole('status').textContent).toBe('No other spaces match “absent”.');
  expect(screen.getByRole('button', {name:'Family'})).toBeTruthy();
});
it('keeps the active space identifiable in a collapsed rail', () => {
  localStorage.setItem('canopy.drive.sidebar-collapsed', '1');
  const onSpaces = vi.fn();
  render(<Sidebar active="drive" onNavigate={vi.fn()} onNewFolder={vi.fn()} onUpload={vi.fn()}
    sites={[{ slug: 'family', name: 'Family', icon: 'folder', color: '#123456', current: true }]}
    failed={false} onRetry={vi.fn()} onSpaces={onSpaces} />);
  const switcher = screen.getByRole('button', { name: 'Spaces, current: Family' });
  expect(switcher.getAttribute('title')).toBe('Family');
  fireEvent.click(switcher);
  expect(onSpaces).toHaveBeenCalledOnce();
});
it('clears the space filter on Escape before letting it bubble', () => {
  const sites = ['alpha','beta','gamma','delta','epsilon','zeta'].map((slug, i) => ({slug,name:slug,current:i === 0}));
  const onKeyDown = vi.fn();
  render(<div onKeyDown={onKeyDown}><Sidebar active="drive" onNavigate={vi.fn()} onNewFolder={vi.fn()} onUpload={vi.fn()} sites={sites} failed={false} onRetry={vi.fn()} /></div>);
  const input = screen.getByRole('textbox', {name:'Filter spaces'}) as HTMLInputElement;
  fireEvent.change(input, {target:{value:'zeta'}});
  fireEvent.keyDown(input, {key:'Escape'});
  expect(input.value).toBe('');
  expect(onKeyDown).not.toHaveBeenCalled();
  fireEvent.keyDown(input, {key:'Escape'});
  expect(onKeyDown).toHaveBeenCalledOnce();
});
