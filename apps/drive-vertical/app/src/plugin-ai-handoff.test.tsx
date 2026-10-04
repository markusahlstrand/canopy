import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildPluginPrompt, PluginAiHandoff } from './plugin-ai-handoff';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('targets the installed viewer and app contracts, without retired portal files', () => {
  expect(buildPluginPrompt('Show .gpx tracks', 'viewer')).toContain('contributes.viewers');
  expect(buildPluginPrompt('Show .gpx tracks', 'viewer')).toContain('item:read');
  expect(buildPluginPrompt('A timer', 'app')).toContain('contributes.detailView');
  expect(buildPluginPrompt('A timer', 'app')).not.toContain('apps/portal');
});

it('copies the described app prompt for review in Studio', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(<PluginAiHandoff />);
  fireEvent.click(screen.getByText('Build with AI'));
  fireEvent.click(screen.getByRole('button', { name: 'App' }));
  fireEvent.change(screen.getByLabelText('Plugin idea'), { target: { value: 'A timer' } });
  fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('A timer')));
  expect((screen.getByLabelText('AI plugin prompt') as HTMLTextAreaElement).value).toContain('contributes.detailView');
});
