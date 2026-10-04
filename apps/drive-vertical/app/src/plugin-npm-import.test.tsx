import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PluginManagement } from './plugin-management';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('loads an npm plugin into Studio and installs only after capability approval', async () => {
  const manifest = { id: 'npm-viewer', name: 'npm viewer', version: '2.0.0', capabilities: [{ kind: 'item:read' }], contributes: { viewers: [{ id: 'text', match: ['text/*'] }] } };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => new Response(JSON.stringify(
    url.endsWith('/people/access') ? { canManage: false } :
    url.endsWith('/plugins') && init?.method !== 'PUT' ? { plugins: [] } :
    url.endsWith('/plugin-import/npm') ? { manifest, source: 'export default () => {}', provenance: { kind: 'npm', ref: '@owner/plugin@next', resolved: '2.0.0' } } : {},
  )));
  vi.stubGlobal('fetch', fetcher);
  render(<PluginManagement open onOpenChange={() => {}} />);
  fireEvent.change(screen.getByLabelText('npm package'), { target: { value: '@owner/plugin' } });
  fireEvent.change(screen.getByLabelText('npm version or tag'), { target: { value: 'next' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review npm plugin' }));
  await screen.findByDisplayValue(/npm-viewer/);
  expect((screen.getByRole('button', { name: 'Install plugin' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: /Approve the capabilities/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Install plugin' }));
  await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
  const body = JSON.parse(fetcher.mock.calls.find(([, init]) => init?.method === 'PUT')![1]!.body as string);
  expect(body.provenance).toEqual({ kind: 'npm', ref: '@owner/plugin@next', resolved: '2.0.0' });
});
