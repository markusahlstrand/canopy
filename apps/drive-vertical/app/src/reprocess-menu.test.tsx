import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@canopy/ui';
import { ActionMenuItems, actionsFor } from './file-table';
import { FIND_ENTITIES, LABEL_WITH_AI, REPROCESS } from './ai-label';

afterEach(cleanup);

const file = { id: '01A', name: 'a.pdf', kind: 'pdf', modified: 'today', size: '1 kB', isFolder: false } as const;

function Menu({ actions, onSelect }: { actions: string[]; onSelect: (a: string) => void }) {
  return (
    <DropdownMenu open>
      <DropdownMenuTrigger>menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <ActionMenuItems actions={actions} onSelect={onSelect} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

it('draws the AI items under one Reprocess submenu, before Delete', async () => {
  const onSelect = vi.fn();
  render(<Menu actions={actionsFor(file, false, false, false, true, true)} onSelect={onSelect} />);
  const top = screen.getAllByRole('menuitem').map((el) => el.textContent);
  expect(top).toEqual(['Open', 'Download', 'Rename', 'Move', REPROCESS, 'Delete']);
  expect(screen.queryByRole('menuitem', { name: LABEL_WITH_AI })).toBeNull();

  fireEvent.keyDown(screen.getByRole('menuitem', { name: REPROCESS }), { key: 'ArrowRight' });
  expect(await screen.findByRole('menuitem', { name: FIND_ENTITIES })).toBeTruthy();
  fireEvent.click(screen.getByRole('menuitem', { name: LABEL_WITH_AI }));
  expect(onSelect).toHaveBeenCalledWith(LABEL_WITH_AI);
});

it('draws no Reprocess where the space runs no AI', () => {
  render(<Menu actions={actionsFor(file)} onSelect={() => {}} />);
  expect(screen.queryByRole('menuitem', { name: REPROCESS })).toBeNull();
});
