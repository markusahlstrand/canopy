import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AccountMenu, accountSession } from './account-menu';

afterEach(cleanup);

const handlers = { onSignIn: vi.fn(), onSignOut: vi.fn() };
const signedIn = { user: { name: 'Ada Example', email: 'ada@example.com' }, principal: '01A' };

it('never invents a person: no user is no session', () => {
  expect(accountSession({ user: null })).toBeNull();
});

it('names a login that holds no space here, without a principal to go on', () => {
  expect(accountSession({ user: { email: 'ada@example.com' } })).toEqual({ principal: 'ada@example.com', display: 'ada@example.com', email: 'ada@example.com' });
});

it('draws the session it is handed and never reads /api/me itself', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const { container } = render(<AccountMenu auth={signedIn} {...handlers} />);
  const menu = container.querySelector('sub-user-menu')!;
  expect(menu.getAttribute('session-url')).toBe('');
  expect(menu.session?.display).toBe('Ada Example');
  expect(menu.hideSwitchUser).toBe(true);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Log in' })).toBeNull();
  fetchSpy.mockRestore();
});

it('offers a login button when signed out, and disables it offline', () => {
  const { rerender } = render(<AccountMenu auth={{ user: null }} {...handlers} />);
  fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
  expect(handlers.onSignIn).toHaveBeenCalledOnce();
  rerender(<AccountMenu auth={{ user: null }} offline {...handlers} />);
  expect((screen.getByRole('button', { name: 'Log in' }) as HTMLButtonElement).disabled).toBe(true);
});

it('keeps sign-out on the shell, which clears the offline mirror before leaving', () => {
  const { container } = render(<AccountMenu auth={signedIn} {...handlers} />);
  const event = new CustomEvent('sub-sign-out', { bubbles: true, composed: true, cancelable: true });
  container.querySelector('sub-user-menu')!.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(handlers.onSignOut).toHaveBeenCalledOnce();
});

it('runs the item chosen, using the current handler after a re-render', () => {
  const first = vi.fn();
  const second = vi.fn();
  const { container, rerender } = render(<AccountMenu auth={signedIn} {...handlers} onOpenViewers={first} />);
  rerender(<AccountMenu auth={signedIn} {...handlers} onOpenViewers={second} />);
  const item = screen.getByText('Plugins…');
  container.querySelector('sub-user-menu')!.dispatchEvent(new CustomEvent('wa-select', { detail: { item } }));
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledOnce();
});
