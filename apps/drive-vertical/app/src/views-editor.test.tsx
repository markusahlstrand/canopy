import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import type { SpaceView } from '../../src/space-settings';
import { ViewsEditor } from './views-editor';

afterEach(cleanup);

let latest: { views: SpaceView[]; defaultView: string | undefined } = { views: [], defaultView: undefined };
function Harness({ saved = [] as string[], initial = [] as SpaceView[] }) {
  const [state, setState] = useState<{ views: SpaceView[]; defaultView: string | undefined }>({ views: initial, defaultView: undefined });
  latest = state;
  return <ViewsEditor value={state.views} defaultView={state.defaultView} savedIds={saved} onChange={(views, defaultView) => setState({ views, defaultView })} />;
}

it('adds a view whose id follows its name until saved, sets it as the default, and drops the default with it', () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: /Add view/ }));
  fireEvent.change(screen.getByLabelText('View 1 name'), { target: { value: 'Per år' } });
  expect(latest.views).toEqual([{ id: 'per-ar', name: 'Per år', groupBy: ['category', 'year'] }]);
  fireEvent.change(screen.getByLabelText('Default view'), { target: { value: 'per-ar' } });
  expect(latest.defaultView).toBe('per-ar');
  // Renaming an unsaved default keeps it the default under its new id.
  fireEvent.change(screen.getByLabelText('View 1 name'), { target: { value: 'By year' } });
  expect(latest).toEqual({ views: [{ id: 'by-year', name: 'By year', groupBy: ['category', 'year'] }], defaultView: 'by-year' });
  fireEvent.click(screen.getByRole('button', { name: 'Remove By year' }));
  expect(latest).toEqual({ views: [], defaultView: undefined });
});

it('keeps a saved view\'s id through a rename, and offers each level only once', () => {
  render(<Harness saved={['by-type']} initial={[{ id: 'by-type', name: 'By type', groupBy: ['type'] }]} />);
  fireEvent.change(screen.getByLabelText('View 1 name'), { target: { value: 'Kinds' } });
  expect(latest.views[0]!.id).toBe('by-type');
  fireEvent.click(screen.getByRole('button', { name: /Level/ }));
  expect(latest.views[0]!.groupBy).toEqual(['type', 'category']);
  const second = screen.getByLabelText('Level 2 of Kinds') as HTMLSelectElement;
  expect([...second.options].map(o => o.value)).not.toContain('type');
  fireEvent.click(screen.getByRole('button', { name: 'Remove level 1' }));
  expect(latest.views[0]!.groupBy).toEqual(['category']);
});

it('lets an owner hand the default back to the folders', () => {
  render(<Harness saved={['by-type']} initial={[{ id: 'by-type', name: 'By type', groupBy: ['type'] }]} />);
  fireEvent.change(screen.getByLabelText('Default view'), { target: { value: 'by-type' } });
  expect(latest.defaultView).toBe('by-type');
  fireEvent.change(screen.getByLabelText('Default view'), { target: { value: '' } });
  expect(latest.defaultView).toBeUndefined();
  // Adding a view keeps whatever default is set.
  fireEvent.change(screen.getByLabelText('Default view'), { target: { value: 'by-type' } });
  fireEvent.click(screen.getByRole('button', { name: /Add view/ }));
  expect(latest.defaultView).toBe('by-type');
});
