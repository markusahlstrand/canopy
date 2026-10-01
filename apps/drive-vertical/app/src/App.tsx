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
import {
  ApiError,
  LOGIN_URL,
  LOGOUT_URL,
  acceptInvite,
  claimOwner,
  currentSite,
  selectSite,
  whoami,
} from './api';
import { DriveScreen } from './drive';
import { clearMirror, offlineIdentity, onMirrorLogout, rememberOfflineIdentity, resumeMirror } from './scope-mirror';

/** Nobody is signed in yet, somebody is, or we have not asked. */
type Session = { state: 'loading' } | { state: 'out' } | { state: 'in'; principal: string };

/** The last verified principal is an offline hint for this routed site only. */
const offlineSiteKey = () => JSON.stringify([window.location.origin, currentSite()]);

/**
 * The two credentials that arrive as a LINK, and what to do with each.
 *
 * `?claim=` opens an install's owner seat; `?invite=` binds a teammate to the member seat
 * an owner pre-minted for them. They are the same object in every way that matters here —
 * single-use, live until consumed, useless without a session — so they take one path
 * rather than two that have to be kept in step.
 *
 * What a failure SAYS still comes from the server, not from here: "already used" and "the
 * network is down" are different facts, and a friendly sentence of our own would caption
 * the second as the first.
 */
const LINKS = {
  claim: {
    param: 'claim',
    stash: 'canopy.drive.pending-claim',
    redeem: (token: string) => claimOwner(token),
  },
  invite: {
    param: 'invite',
    stash: 'canopy.drive.pending-invite',
    redeem: (token: string) => acceptInvite(token),
  },
} as const;

type LinkKind = keyof typeof LINKS;
/** Claim first: an unclaimable install is worse than an unaccepted invitation. */
const KINDS = ['claim', 'invite'] as const satisfies readonly LinkKind[];

/**
 * Where a link's token waits out a login round-trip.
 *
 * NOT `returnTo`. The token is a live credential until it is consumed, and a login URL
 * carrying it is one more address bar, history entry and request log to leak it from —
 * on top of the link the platform already minted. `sessionStorage` is same-origin and
 * per-tab, reaches no server, and dies with the tab.
 */
const readStash = (kind: LinkKind): string | null => {
  try {
    return window.sessionStorage.getItem(LINKS[kind].stash);
  } catch {
    return null;
  }
};

/** False when storage refused us — private mode, blocked site data. The caller has a plan. */
const stash = (kind: LinkKind, token: string): boolean => {
  try {
    window.sessionStorage.setItem(LINKS[kind].stash, token);
    return true;
  } catch {
    return false;
  }
};

const clearStash = (kind: LinkKind) => {
  try {
    window.sessionStorage.removeItem(LINKS[kind].stash);
  } catch {
    // Nothing to clear if we could never write.
  }
};

/**
 * One redemption per token, however many times the effect runs.
 *
 * `StrictMode` mounts every effect twice, and both passes read the same token before
 * either request finishes. These are single-use: one pass would consume the token and the
 * other would take the 403, leaving a signed-in page wearing a "this link is not valid"
 * error about a redemption that in fact succeeded. Sharing the in-flight promise makes the
 * second pass await the first's answer instead of racing it.
 */
let inFlight: { key: string; result: Promise<unknown> } | null = null;

const redeemOnce = (kind: LinkKind, token: string): Promise<unknown> => {
  // Keyed by kind as well as token, so the two links cannot alias each other.
  const key = `${kind}:${token}`;
  if (inFlight?.key !== key) inFlight = { key, result: LINKS[kind].redeem(token) };
  return inFlight.result;
};

/** A link's token, taken OUT of the URL on sight, or whatever is waiting in the stash. */
function pendingLink(): { kind: LinkKind; token: string; fromUrl: boolean } | null {
  const url = new URL(window.location.href);
  for (const kind of KINDS) {
    const { param } = LINKS[kind];
    const fromUrl = url.searchParams.get(param);
    if (fromUrl) {
      // Before anything can await: a token in the address bar is one screenshot or pasted
      // link from being someone else's.
      url.searchParams.delete(param);
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      return { kind, token: fromUrl, fromUrl: true };
    }
  }
  for (const kind of KINDS) {
    const waiting = readStash(kind);
    if (waiting) return { kind, token: waiting, fromUrl: false };
  }
  return null;
}

/**
 * Who am I — and if a selected space is the reason nobody is, stop selecting it.
 *
 * `/api/me` resolves the principal in the SELECTED space, so a selection pointing at a
 * space this login is no longer bound in answers 401. That renders the signed-out shell,
 * which mounts no rail — and the rail is the only thing that can change space. The
 * selection outlives reloads, so the install became unreachable until someone cleared
 * their site data: signed in, told they are not, with no control on screen that helps.
 *
 * So a 401 WITH a selection in force is retried without it. The `?site=` parameter goes
 * too, or a reload would restore the state we just escaped. If the second answer is also
 * 401 then nobody is signed in and the selection was never the problem — put it back, so
 * signing in returns to the space they chose.
 */
const whoamiWithoutStaleSpace = async (): ReturnType<typeof whoami> => {
  try {
    return await whoami();
  } catch (e: unknown) {
    const selected = currentSite();
    if (!selected || !(e instanceof ApiError) || e.status !== 401) throw e;

    selectSite(null);
    const url = new URL(window.location.href);
    if (url.searchParams.has('site')) {
      url.searchParams.delete('site');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }

    try {
      return await whoami();
    } catch (retry: unknown) {
      // Put the selection back — and if storage refuses to hold it, put it back where it
      // came from. In a private window the URL is the ONLY carrier (the rail's own rule),
      // and this path has just deleted it, so restoring memory alone restores nothing: the
      // sign-in that follows is a full navigation, and module memory does not survive it.
      if (!selectSite(selected)) {
        url.searchParams.set('site', selected);
        window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      }
      throw retry;
    }
  }
};

export default function App() {
  const [session, setSession] = useState<Session>({ state: 'loading' });
  const [error, setError] = useState<string | null>(null);

  /**
   * Boot: redeem the link this page was opened as, if it was one, then ask who we are.
   *
   * Order matters. Until the seat is bound, `whoami` is exactly the 401 the link exists to
   * fix, so asking first renders the signed-out shell and its Sign in button — which is
   * the loop this closes: sign in, resolve to nobody, get offered the button again. True
   * of an owner claim and of an invitation alike: an invitee's subject maps to no
   * principal in this space until they accept.
   *
   * Redeeming needs a session (both bind whoever is signed in), so a 401 from it means
   * "not signed in yet" rather than "bad token" — park the token, send them through login,
   * and they land back on this effect with a session and the redemption still pending. The
   * token itself never waits in a URL; see `readStash`.
   */
  useEffect(() => {
    const boot = async () => {
      const pending = pendingLink();
      if (!pending) return whoamiWithoutStaleSpace();
      const { kind, token, fromUrl } = pending;

      try {
        await redeemOnce(kind, token);
        clearStash(kind);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          // Not signed in yet, so go get a session — but only on the way IN from a link.
          // A STASHED token that still 401s means the round-trip already happened without
          // producing one (the person backed out at the issuer), and bouncing them again
          // is a loop. The stash outlives that, so signing in by hand still completes the
          // redemption on the next load.
          if (fromUrl) {
            window.location.assign(
              // `returnTo` is where the token would otherwise have to ride. It only does
              // so when storage refused to hold it, which is one more URL than we want
              // and still better than a link nobody can redeem.
              stash(kind, token)
                ? LOGIN_URL
                : `${LOGIN_URL}?returnTo=${encodeURIComponent(`/?${LINKS[kind].param}=${token}`)}`,
            );
            return null;
          }
        } else if (e instanceof TypeError || (e instanceof ApiError && e.status >= 500)) {
          // A disconnected tab cannot redeem the link yet. Keep its token for the next
          // online load instead of treating a network failure as an invalid invitation.
          stash(kind, token);
        } else {
          // A dead link is worth SAYING — somebody followed one they were given, and
          // silence would leave them looking at a drive that is not the one they were
          // invited to. Drop it so a reload stops retrying a token that cannot work, and
          // fall through to `whoami`: the seat may have been taken in another tab, and
          // that is the call which knows.
          clearStash(kind);
          setError(e instanceof ApiError ? e.message : String(e));
        }
      }
      return whoamiWithoutStaleSpace();
    };

    boot()
      .then((me) => {
        if (me) {
          void resumeMirror()
            .then(() => rememberOfflineIdentity(offlineSiteKey(), me.principal))
            .catch(() => {})
            .finally(() => setSession({ state: 'in', principal: me.principal }));
        }
      })
      // A 401 is the logged-out state, not a failure — anything else is.
      .catch(async (e: unknown) => {
        if (e instanceof ApiError && e.status === 401) {
          setSession({ state: 'out' });
          // The server answered: this is not an outage, so its old offline identity
          // must not be used on a later disconnected load.
          void clearMirror().catch(() => {});
          return;
        }
        if (e instanceof TypeError || (e instanceof ApiError && e.status >= 500)) {
          try {
            const principal = await offlineIdentity(offlineSiteKey());
            if (principal) {
              setSession({ state: 'in', principal });
              return;
            }
          } catch {
            // IndexedDB may be blocked; the signed-out/error state remains honest.
          }
        }
        setSession({ state: 'out' });
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(() => onMirrorLogout(() => {
    setSession({ state: 'out' });
    setError(null);
  }), []);

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
          onSignOut={() => {
            void clearMirror()
              .catch(() => {})
              .finally(() => { window.location.href = LOGOUT_URL; });
          }}
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
