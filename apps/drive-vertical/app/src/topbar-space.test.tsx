import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Topbar } from './topbar';

afterEach(cleanup);

it('shows the active space and opens the space picker from the header', () => {
  const onOpenSpaces = vi.fn();
  render(<Topbar breadcrumb={['My Drive']} spaceName="Family" onOpenSpaces={onOpenSpaces} onOpenMenu={vi.fn()} onOpenCmd={vi.fn()} onUpload={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', {name:'Spaces, current: Family'}));
  expect(onOpenSpaces).toHaveBeenCalledOnce();
});

it('disables upload while a linked folder is unresolved without blocking search', () => {
  render(<Topbar breadcrumb={['My Drive']} onOpenMenu={vi.fn()} onOpenCmd={vi.fn()} onUpload={vi.fn()} writeBlocked />);
  expect((screen.getByRole('button', {name:'Upload files'}) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', {name:'Search or jump to'}) as HTMLButtonElement).disabled).toBe(false);
});

it("offers a login in the header while signed out, since a phone's rail is in the closed sheet", () => {
  const onSignIn = vi.fn();
  const { rerender } = render(<Topbar breadcrumb={['My Drive']} onOpenMenu={vi.fn()} onOpenCmd={vi.fn()} onSignIn={onSignIn} />);
  fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
  expect(onSignIn).toHaveBeenCalledOnce();
  rerender(<Topbar breadcrumb={['My Drive']} onOpenMenu={vi.fn()} onOpenCmd={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Log in' })).toBeNull();
});
