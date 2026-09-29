/**
 * The drive's own front end.
 *
 * Scope-shaped on purpose: the hostname already resolved to a scope before the worker
 * saw the request, so the space is never in a URL here and the tenant is never in a
 * header. The sidebar does list the other spaces this login is bound in and can select
 * one (`x-site`, see `api.ts`) — but that names an ADDRESS the platform re-checks, which
 * is a different thing from the portal deciding for itself which space you are in.
 *
 * It renders with `@canopy/ui` — the same shadcn/radix primitives and the same
 * Canopy tokens the trusted plugins use.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Icon } from '@canopy/ui';
import { ApiError, LOGIN_URL, LOGOUT_URL, claimOwner, whoami } from './api';
import { DriveScreen } from './drive';

/** Nobody is signed in yet, somebody is, or we have not asked. */
type Session = { state: 'loading' } | { state: 'out' } | { state: 'in'; principal: string };

/**
 * Where an owner-claim token waits out a login round-trip.
 *
 * NOT `returnTo`. The token is a live credential until it is consumed, and a login URL
 * carrying it is one more address bar, history entry and request log to leak it from —
 * on top of the `/?claim=` link the platform already mints. `sessionStorage` is
 * same-origin and per-tab, reaches no server, and dies with the tab.
 */
const CLAIM_STASH = 'canopy.drive.pending-claim';

const readStash = (): string | null => {
  try {
    return window.sessionStorage.getItem(CLAIM_STASH);
  } catch {
    return null;
  }
};

/** False when storage refused us — private mode, blocked site data. The caller has a plan. */
const stash = (token: string): boolean => {
  try {
    window.sessionStorage.setItem(CLAIM_STASH, token);
    return true;
  } catch {
    return false;
  }
};

const clearStash = () => {
  try {
    window.sessionStorage.removeItem(CLAIM_STASH);
  } catch {
    // Nothing to clear if we could never write.
  }
};

/**
 * One claim per token, however many times the effect runs.
 *
 * `StrictMode` mounts every effect twice, and both passes read the same token before
 * either request finishes. A claim is single-use: one would consume it and the other
 * would take the 403, leaving a signed-in page wearing a "this link is not valid" error
 * about a claim that in fact succeeded. Sharing the in-flight promise makes the second
 * pass await the first's answer instead of racing it.
 */
let inFlight: { token: string; result: Promise<unknown> } | null = null;

const claimOnce = (token: string): Promise<unknown> => {
  if (inFlight?.token !== token) inFlight = { token, result: claimOwner(token) };
  return inFlight.result;
};

export default function App() {
  const [session, setSession] = useState<Session>({ state: 'loading' });
  const [error, setError] = useState<string | null>(null);

  /**
   * Boot: redeem an owner-claim link if this page was opened as one, then ask who we are.
   *
   * Order matters. Until the seat is bound, `whoami` is exactly the 401 the claim exists
   * to fix, so asking first renders the signed-out shell and its Sign in button — which
   * is the loop this closes: sign in, resolve to nobody, get offered the button again.
   *
   * A claim needs a session (it binds whoever is signed in), so a 401 from it means "not
   * signed in yet" rather than "bad token" — park the token, send them through login, and
   * they land back on this effect with a session and the claim still pending. The token
   * itself never waits in a URL; see `CLAIM_STASH`.
   */
  useEffect(() => {
    const boot = async () => {
      // Out of the URL on sight, before anything can await: a token in the address bar
      // is one screenshot or pasted link from being someone else's.
      const url = new URL(window.location.href);
      const fromUrl = url.searchParams.get('claim');
      if (fromUrl) {
        url.searchParams.delete('claim');
        window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      }

      const token = fromUrl ?? readStash();
      if (!token) return whoami();

      try {
        await claimOnce(token);
        clearStash();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          // Not signed in yet, so go get a session — but only on the way IN from a link.
          // A STASHED token that still 401s means the round-trip already happened without
          // producing one (the person backed out at the issuer), and bouncing them again
          // is a loop. The stash outlives that, so signing in by hand still completes the
          // claim on the next load.
          if (fromUrl) {
            window.location.assign(
              // `returnTo` is where the token would otherwise have to ride. It only does
              // so when storage refused to hold it, which is one more URL than we want
              // and still better than an install nobody can claim.
              stash(token) ? LOGIN_URL : `${LOGIN_URL}?returnTo=${encodeURIComponent(`/?claim=${token}`)}`,
            );
            return null;
          }
        } else {
          // A dead link is worth SAYING — the person followed one the dashboard told them
          // to open. Drop it so a reload stops retrying a token that cannot work, and
          // fall through to `whoami`: the seat may have been claimed in another tab, and
          // that is the call which knows.
          clearStash();
          setError(e instanceof ApiError ? e.message : String(e));
        }
      }
      return whoami();
    };

    boot()
      .then((me) => {
        if (me) setSession({ state: 'in', principal: me.principal });
      })
      // A 401 is the logged-out state, not a failure — anything else is.
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) return setSession({ state: 'out' });
        setSession({ state: 'out' });
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  /**
   * A full-height shell, not a centred column.
   *
   * The sidebar is a column of the shell and has to reach the floor, so this is
   * `h-dvh` with `min-h-0` children and exactly one scrolling region inside the
   * screen — the portal's layout, which is what makes a rail a rail rather than a
   * block that stops where the file list happens to end.
   *
   * The error banner sits ABOVE the shell, spanning it: a failure to list spaces
   * belongs to the install, not to the pane it was noticed in.
   */
  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      {error ? (
        <p className="shrink-0 border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {session.state === 'loading' ? (
        <p className="p-8 text-sm text-muted-foreground">Loading…</p>
      ) : session.state === 'out' ? (
        <main className="mx-auto w-full max-w-4xl px-4 py-8">
          <SignedOut />
        </main>
      ) : (
        <DriveScreen
          onError={setError}
          auth={{ user: { name: session.principal }, principal: session.principal }}
          onSignIn={() => (window.location.href = LOGIN_URL)}
          onSignOut={() => (window.location.href = LOGOUT_URL)}
        />
      )}
    </div>
  );
}

/**
 * The logged-out shell. It says what this install is rather than only offering a
 * button, because a fresh vertical with no issuer configured lands here and the
 * reason it cannot sign anyone in is worth stating.
 */
function SignedOut() {
  return (
    <div className="rounded-lg border border-border p-8 text-center">
      <Icon name="key-round" className="mx-auto mb-3 size-6 text-muted-foreground" />
      <h2 className="mb-1 text-lg font-medium">Sign in to this space</h2>
      <p className="mx-auto mb-5 max-w-sm text-sm text-muted-foreground">
        This drive is one space, and the hostname already chose it. Signing in maps you to a
        principal inside it.
      </p>
      <Button asChild>
        <a href={LOGIN_URL}>Sign in</a>
      </Button>
    </div>
  );
}
