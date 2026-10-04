import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SpacesDialog } from './spaces-dialog';
afterEach(cleanup);
const props = { open: true, onOpenChange: vi.fn(), failed: false, onRetry: vi.fn(), canManage: true, onMembers: vi.fn() };
it('lists accessible spaces, filters names/slugs and offers members only for the current space', () => {
  render(<SpacesDialog {...props} sites={[{ slug: 'family', name: 'Family', current: true }, { slug: 'work', name: 'Team', current: false }]} />);
  expect(screen.getByText('Current space')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Manage members' })); expect(props.onMembers).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByLabelText('Find a space'), { target: { value: 'work' } });
  expect(screen.queryByRole('button', { name: 'Manage members' })).toBeNull(); expect(screen.getByRole('button', { name: 'Open Team' })).toBeTruthy();
});
it('distinguishes failure, loading and having no spaces', () => {
  const view = render(<SpacesDialog {...props} sites={null} />); expect(screen.getByText('Loading spaces…')).toBeTruthy();
  view.rerender(<SpacesDialog {...props} sites={[]} failed />); fireEvent.click(screen.getByRole('button', { name: 'Retry spaces' })); expect(props.onRetry).toHaveBeenCalledOnce();
  view.rerender(<SpacesDialog {...props} sites={[]} />); expect(screen.getByText(/You have no spaces available/)).toBeTruthy();
});

it('disables switching and hides management while offline', () => {
 render(<SpacesDialog {...props} offline sites={[{slug:'family',name:'Family',current:true},{slug:'team',name:'Team',current:false}]} />);
 expect((screen.getByRole('button',{name:'Open Team'}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.queryByRole('button',{name:'Manage members'})).toBeNull();
});
it('disables space creation while offline and guides managers with no spaces', () => {
 const create = vi.fn();
 const view = render(<SpacesDialog {...props} offline onCreate={create} sites={[]} />);
 expect((screen.getByRole('button', {name:'Create space'}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByText(/Reconnect to check spaces or create one/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button', {name:'Create space'})); expect(create).not.toHaveBeenCalled();
 view.rerender(<SpacesDialog {...props} onCreate={create} sites={[]} />);
 fireEvent.click(screen.getByRole('button', {name:'Create space'})); expect(create).toHaveBeenCalledOnce();
});
