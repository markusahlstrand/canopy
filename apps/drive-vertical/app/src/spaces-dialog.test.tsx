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
  expect(screen.getByRole('button', { name: 'Manage members' })).toBeTruthy(); expect(screen.getByRole('button', { name: 'Open Team' })).toBeTruthy();
});
it('distinguishes failure, loading and having no spaces', () => {
  const view = render(<SpacesDialog {...props} sites={null} />); expect(screen.getByText('Loading spaces…')).toBeTruthy();
  view.rerender(<SpacesDialog {...props} sites={[]} failed />); fireEvent.click(screen.getByRole('button', { name: 'Retry spaces' })); expect(props.onRetry).toHaveBeenCalledOnce();
  view.rerender(<SpacesDialog {...props} sites={[]} />); expect(screen.getByText(/You have no spaces available/)).toBeTruthy();
});
it('keeps the last space list usable after a refresh failure', () => {
  render(<SpacesDialog {...props} failed sites={[{ slug: 'team', name: 'Team', current: false }]} />);
  expect(screen.getByRole('alert').textContent).toContain('Showing the last list');
  expect(screen.getByRole('button', { name: 'Open Team' })).toBeTruthy();
});
it('waits for a connection before retrying a failed roster', () => {
  render(<SpacesDialog {...props} sites={[]} failed offline />);
  expect((screen.getByRole('button', { name: 'Retry spaces' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Refresh spaces' }) as HTMLButtonElement).disabled).toBe(true);
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
it('copies a clean link to the selected space', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  window.history.replaceState(null, '', '/nested?site=old&folder=private&file=secret&path=deep&claim=claim-token&invite=invite-token#private');
  render(<SpacesDialog {...props} sites={[{ slug: 'team', name: 'Team', current: false }]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
  await screen.findByText('Copied link to team');
  const url = new URL(writeText.mock.calls[0]![0]);
  expect(url.pathname).toBe('/');
  expect(url.search).toBe('?site=team');
  expect(url.hash).toBe('');
});
it('puts the current space first and clears an old search when reopened', () => {
 const sites = [{slug:'work',name:'Work',current:false},{slug:'home',name:'Home',current:true}];
 const view = render(<SpacesDialog {...props} sites={sites} />);
 expect(screen.getAllByRole('listitem')[0]?.textContent).toContain('Home');
 fireEvent.change(screen.getByLabelText('Find a space'), {target:{value:'work'}});
 expect(screen.getByText('Home')).toBeTruthy();
 view.rerender(<SpacesDialog {...props} open={false} sites={sites} />);
 view.rerender(<SpacesDialog {...props} sites={sites} />);
 expect(screen.getByText('Home')).toBeTruthy();
 expect((screen.getByLabelText('Find a space') as HTMLInputElement).value).toBe('');
});
it('explains an unmatched query while keeping the active space visible', () => {
  render(<SpacesDialog {...props} sites={[{ slug: 'home', name: 'Home', current: true }, { slug: 'work', name: 'Work', current: false }]} />);
  fireEvent.change(screen.getByLabelText('Find a space'), { target: { value: 'zzz' } });
  expect(screen.getByText('Home')).toBeTruthy();
  expect(screen.queryByText('Work')).toBeNull();
  expect(screen.getByText('No other spaces match “zzz”.')).toBeTruthy();
});
it('uses the slug when a space has no display name', () => {
  render(<SpacesDialog {...props} sites={[{ slug: 'legacy-space', name: '  ', current: false }]} />);
  expect(screen.getByRole('button', { name: 'Open legacy-space' })).toBeTruthy();
});
