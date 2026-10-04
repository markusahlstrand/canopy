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
