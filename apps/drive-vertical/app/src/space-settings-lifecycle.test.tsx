import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SpaceSettingsDialog } from './space-settings-dialog';
import * as api from './api';
import { defaultSpaceSettings, type SpaceSettings } from '../../src/space-settings';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('ignores a save response from a previous dialog visit', async () => {
  vi.spyOn(api, 'getSpaceSettings').mockResolvedValueOnce(defaultSpaceSettings('First')).mockResolvedValue(defaultSpaceSettings('Second'));
  let finish!: (settings: SpaceSettings) => void;
  vi.spyOn(api, 'updateSpaceSettings').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const saved = vi.fn(), closed = vi.fn();
  const view = render(<SpaceSettingsDialog open onSaved={saved} onOpenChange={closed} />);
  await screen.findByDisplayValue('First');
  fireEvent.change(screen.getByLabelText('Space name'), { target: { value: 'First edited' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save space' }));
  view.rerender(<SpaceSettingsDialog open={false} onSaved={saved} onOpenChange={closed} />);
  view.rerender(<SpaceSettingsDialog open onSaved={saved} onOpenChange={closed} />);
  await screen.findByDisplayValue('Second');
  await act(async () => finish(defaultSpaceSettings('First edited')));
  expect(screen.getByDisplayValue('Second')).toBeTruthy();
  expect(saved).not.toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled();
});
