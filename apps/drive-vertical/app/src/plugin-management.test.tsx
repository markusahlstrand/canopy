import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PluginManagement } from './plugin-management';
import { setImageViewerEnabled } from './image-viewer';
afterEach(() => { cleanup(); setImageViewerEnabled(true); });
it('manages enabled state and explains file access and matching contributions', () => {
  setImageViewerEnabled(true); render(<PluginManagement open onOpenChange={() => {}} />);
  expect(screen.getByText('Handles: image/*')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Disable image viewer' }));
  expect(screen.getByText('No optional viewers are enabled.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Enable image viewer' })); expect(screen.getByText('Handles: image/*')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Find a plugin'), { target: { value: 'absent' } }); expect(screen.getByText('No available plugins match this search.')).toBeTruthy();
});
it('restores bundled catalog review and source authoring', () => {
  render(<PluginManagement open onOpenChange={() => {}} />);
  fireEvent.click(screen.getByRole('button', {name:'Review Markdown'}));
  expect((screen.getByLabelText('Plugin manifest') as HTMLTextAreaElement).value).toContain('markdown-editor');
  expect((screen.getByLabelText('Plugin source') as HTMLTextAreaElement).value).toContain('export default');
  expect(screen.getByRole('button', {name:'Install plugin'})).toBeTruthy();
});
