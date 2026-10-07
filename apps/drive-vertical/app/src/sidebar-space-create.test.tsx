import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Sidebar } from './sidebar';

afterEach(() => { cleanup(); localStorage.clear(); });

it('keeps space creation reachable when the list is empty', () => {
  const onCreateSpace = vi.fn();
  render(<Sidebar active="drive" onNavigate={vi.fn()} onNewFolder={vi.fn()} onUpload={vi.fn()}
    sites={[]} failed={false} onRetry={vi.fn()} onCreateSpace={onCreateSpace} />);
  expect(screen.getByText('No spaces yet')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Create space' }));
  expect(onCreateSpace).toHaveBeenCalledOnce();
});

it('offers settings, members and plugins from the current space row', () => {
  const settings = vi.fn(), members = vi.fn(), plugins = vi.fn();
  const sites = [{slug:'family',name:'Family',current:true},{slug:'work',name:'Work',current:false}];
  render(<Sidebar active="drive" onNavigate={vi.fn()} onNewFolder={vi.fn()} onUpload={vi.fn()}
    sites={sites} failed={false} onRetry={vi.fn()} canManageSpace
    onSpaceSettings={settings} onSpaceMembers={members} onSpacePlugins={plugins} />);
  expect(screen.queryByRole('button', {name:'Manage Work'})).toBeNull();
  const trigger = screen.getByRole('button', {name:'Manage Family'});
  fireEvent.pointerDown(trigger, {button:0,ctrlKey:false});
  fireEvent.click(screen.getByRole('menuitem', {name:'Space settings'}));
  expect(settings).toHaveBeenCalledOnce();
});

it('hides the current-space menu offline', () => {
  render(<Sidebar active="drive" onNavigate={vi.fn()} onNewFolder={vi.fn()} onUpload={vi.fn()}
    sites={[{slug:'family',name:'Family',current:true}]} failed={false} onRetry={vi.fn()}
    canManageSpace offline onSpaceSettings={vi.fn()} />);
  expect(screen.queryByRole('button', {name:'Manage Family'})).toBeNull();
});

it('waits for reconnection before retrying the space roster', () => {
  const onRetry = vi.fn();
  render(<Sidebar active="drive" onNavigate={vi.fn()} onNewFolder={vi.fn()} onUpload={vi.fn()}
    sites={[]} failed onRetry={onRetry} offline />);
  const retry = screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement;
  expect(retry.disabled).toBe(true);
  fireEvent.click(retry);
  expect(onRetry).not.toHaveBeenCalled();
});

it('disables New while a linked folder is unresolved', () => {
  render(<Sidebar active="drive" onNavigate={vi.fn()} onNewFolder={vi.fn()} onUpload={vi.fn()}
    sites={[]} failed={false} onRetry={vi.fn()} writeBlocked />);
  expect((screen.getByRole('button', {name:'New'}) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', {name:'My Drive'}) as HTMLButtonElement).disabled).toBe(false);
});

it('keeps the current space visible while explaining that no other space matches', () => {
  render(<Sidebar active="drive" onNavigate={vi.fn()} onNewFolder={vi.fn()} onUpload={vi.fn()}
    sites={[{slug:'family',name:'Family',current:true},{slug:'work',name:'Work',current:false},
      {slug:'school',name:'School',current:false},{slug:'travel',name:'Travel',current:false},
      {slug:'archive',name:'Archive',current:false},{slug:'photos',name:'Photos',current:false}]}
    failed={false} onRetry={vi.fn()} />);
  fireEvent.change(screen.getByRole('textbox', {name:'Filter spaces'}), {target:{value:'Family'}});
  expect(screen.getByRole('button', {name:'Family'})).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('No other spaces match “Family”.');
  expect(screen.queryByRole('button', {name:'Work'})).toBeNull();
});
