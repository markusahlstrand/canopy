/**
 * The account control at the foot of the rail: Substrat's `<sub-user-menu>`, fed the
 * session the shell already holds.
 *
 * `session-url` is empty on purpose. `/api/me` answers `{ principal, user }`, not the
 * `{ principal, display }` the element parses, and a login bound to no space has a null
 * principal — reading it again would draw that login as signed out.
 *
 * "Switch user" stays hidden: it would navigate past `onSignOut`, which is what clears
 * the offline mirror, and leave one login's files on the device for the next.
 */
import { useEffect, useRef, type DetailedHTMLProps, type HTMLAttributes } from 'react';
import '@substrat-run/elements/user-menu';
import type {} from '@substrat-run/elements/jsx';
import type { SubUserMenu } from '@substrat-run/elements/user-menu';
import type { Session } from '@substrat-run/elements/session';
import { Button, Icon } from '@canopy/ui';
import type { Me } from './api';

type SubUserMenuProps = DetailedHTMLProps<HTMLAttributes<SubUserMenu>, SubUserMenu> & {
  'session-url'?: string;
  session?: Session | null;
  show?: 'avatar' | 'name' | 'email';
  placement?: SubUserMenu['placement'];
  hideSwitchUser?: boolean;
};

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'sub-user-menu': SubUserMenuProps;
    }
  }
}

/** The element's session for this login, or null for nobody. Never a made-up persona. */
export function accountSession(auth: Me): Session | null {
  if (!auth.user) return null;
  const { name, email } = auth.user;
  return {
    // A principal is per space and may be absent; the avatar's colour only needs something stable.
    principal: auth.principal ?? email ?? name ?? 'account',
    display: name ?? email ?? 'Account',
    ...(email ? { email } : {}),
  };
}

interface AccountMenuProps {
  auth: Me;
  /** The collapsed rail has room for the avatar alone. */
  compact?: boolean;
  offline?: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
  /** Each is absent when this login may not use it, or it can't work right now. */
  onOpenPeople?: () => void;
  onOpenViewers?: () => void;
  onOpenAppPasswords?: () => void;
}

export function AccountMenu({ auth, compact = false, offline, onSignIn, onSignOut, onOpenPeople, onOpenViewers, onOpenAppPasswords }: AccountMenuProps) {
  const menu = useRef<SubUserMenu>(null);
  const items = [
    onOpenPeople && { value: 'people', label: 'People…', run: onOpenPeople },
    onOpenViewers && { value: 'plugins', label: 'Plugins…', run: onOpenViewers },
    onOpenAppPasswords && { value: 'webdav', label: 'Connect with WebDAV…', run: onOpenAppPasswords },
  ].filter(item => !!item);

  // Read through refs so the listeners stay attached across renders of a changing list.
  const latest = useRef({ items, onSignOut });
  latest.current = { items, onSignOut };

  useEffect(() => {
    const element = menu.current;
    if (!element) return;
    const select = (event: Event) => {
      const value = (event as CustomEvent<{ item: HTMLElement & { value?: string } }>).detail.item.value;
      latest.current.items.find(item => item.value === value)?.run();
    };
    const signOut = (event: Event) => {
      // The shell's sign-out guards unsaved drafts and clears the mirror, then navigates.
      event.preventDefault();
      latest.current.onSignOut();
    };
    element.addEventListener('wa-select', select);
    element.addEventListener('sub-sign-out', signOut);
    return () => {
      element.removeEventListener('wa-select', select);
      element.removeEventListener('sub-sign-out', signOut);
    };
  }, []);

  return (
    <sub-user-menu
      ref={menu}
      session-url=""
      session={accountSession(auth)}
      show={compact ? 'avatar' : 'name'}
      placement="top-start"
      hideSwitchUser
      className="canopy-account block min-w-0"
    >
      {items.map(item => <wa-dropdown-item key={item.value} value={item.value}>{item.label}</wa-dropdown-item>)}
      {auth.user ? null : (
        <span slot="signed-out" className="block">
          <Button
            onClick={onSignIn}
            disabled={offline}
            title={offline ? "You're offline" : compact ? 'Log in' : undefined}
            aria-label="Log in"
            size={compact ? 'icon' : 'default'}
            className="w-full gap-1.5"
          >
            <Icon name="log-out" size={16} className="rotate-180" />
            {compact ? null : 'Log in'}
          </Button>
        </span>
      )}
    </sub-user-menu>
  );
}
