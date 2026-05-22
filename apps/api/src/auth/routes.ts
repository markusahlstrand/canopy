import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import type { AuthConfig } from "./config";
import type { UserProfile } from "./oidc";
import {
  buildAuthorizeUrl,
  discover,
  exchangeCode,
  fetchUserInfo,
  pkceChallenge,
  randomToken,
  refreshTokens,
  validateIdToken,
} from "./oidc";
import { seal, unseal, type SessionData } from "./session-cookie";

const SID = "canopy_sid";
const PENDING = "canopy_auth";

interface PendingAuth {
  state: string;
  verifier: string;
  nonce: string;
  returnTo: string;
  redirectUri: string;
}

type Ctx = { req: { url: string } };

const requestOrigin = (c: Ctx) => new URL(c.req.url).origin;
const isHttps = (c: Ctx) => new URL(c.req.url).protocol === "https:";

/** OIDC redirect URI: explicit override, else this request's origin. Deriving it
 *  from the request means it works on workers.dev, custom domains, etc. with no
 *  config — the override is only needed when the public URL differs from the
 *  request origin (e.g. behind Vite's dev proxy). */
const returnBase = (c: Ctx, cfg: AuthConfig) => cfg.appBaseUrl ?? requestOrigin(c);
const callbackUri = (c: Ctx, cfg: AuthConfig) => cfg.redirectUri ?? `${returnBase(c, cfg)}/api/auth/callback`;

function cookieOpts(secure: boolean, maxAge: number): CookieOptions {
  return { httpOnly: true, sameSite: "Lax", secure, path: "/", maxAge };
}

/** Read the current user from the session cookie (no refresh). Null if anonymous/expired. */
export async function getSessionUser(c: Context, cfg: AuthConfig | null): Promise<UserProfile | null> {
  if (!cfg) return null;
  const raw = getCookie(c, SID);
  if (!raw) return null;
  const session = await unseal(cfg.sessionSecret, raw);
  if (!session || session.expiresAt <= Date.now()) return null;
  return session.user;
}

/** Restrict post-login redirects to same-origin relative paths (no open redirect). */
function safeReturn(c: Ctx, cfg: AuthConfig, returnTo: string | undefined): string {
  const path = returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
  return `${returnBase(c, cfg)}${path}`;
}

/**
 * The auth BFF. The session is an encrypted cookie (see session-cookie.ts) — no
 * server-side store. When `cfg` is null, auth is unconfigured: /me reports
 * anonymous and login is unavailable, so the app still runs.
 */
/** Called after a successful login — e.g. to upsert the user directory + resolve invites. */
export type OnLogin = (user: {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
  emailVerified?: boolean;
}) => Promise<void>;

export function createAuthApp(cfg: AuthConfig | null, onLogin?: OnLogin) {
  const app = new Hono();

  app.get("/me", async (c) => {
    if (!cfg) return c.json({ user: null, authConfigured: false });
    const raw = getCookie(c, SID);
    const session = raw ? await unseal(cfg.sessionSecret, raw) : null;
    if (!session) {
      if (raw) deleteCookie(c, SID, { path: "/" });
      return c.json({ user: null, authConfigured: true });
    }

    // Refresh a stale access token if we can; otherwise the session is over.
    if (session.expiresAt <= Date.now()) {
      if (!session.refreshToken) {
        deleteCookie(c, SID, { path: "/" });
        return c.json({ user: null, authConfigured: true });
      }
      try {
        const t = await refreshTokens(cfg, session.refreshToken);
        const updated: SessionData = {
          ...session,
          accessToken: t.access_token,
          refreshToken: t.refresh_token ?? session.refreshToken,
          expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
        };
        setCookie(c, SID, await seal(cfg.sessionSecret, updated), cookieOpts(isHttps(c), cfg.sessionTtlSeconds));
        return c.json({ user: updated.user, authConfigured: true });
      } catch {
        deleteCookie(c, SID, { path: "/" });
        return c.json({ user: null, authConfigured: true });
      }
    }

    return c.json({ user: session.user, authConfigured: true });
  });

  app.get("/login", async (c) => {
    if (!cfg) return c.json({ error: "auth not configured" }, 503);
    const verifier = randomToken(32);
    const pending: PendingAuth = {
      state: randomToken(16),
      verifier,
      nonce: randomToken(16),
      returnTo: c.req.query("returnTo") ?? "/",
      redirectUri: callbackUri(c, cfg),
    };
    setCookie(c, PENDING, JSON.stringify(pending), cookieOpts(isHttps(c), 600));
    const url = await buildAuthorizeUrl(cfg, {
      state: pending.state,
      nonce: pending.nonce,
      codeChallenge: await pkceChallenge(verifier),
      redirectUri: pending.redirectUri,
    });
    return c.redirect(url);
  });

  app.get("/callback", async (c) => {
    if (!cfg) return c.json({ error: "auth not configured" }, 503);
    const raw = getCookie(c, PENDING);
    deleteCookie(c, PENDING, { path: "/" });
    if (!raw) return c.json({ error: "missing auth state" }, 400);

    if (c.req.query("error")) return c.redirect(safeReturn(c, cfg, "/"));

    let pending: PendingAuth;
    try {
      pending = JSON.parse(raw) as PendingAuth;
    } catch {
      return c.json({ error: "bad auth state" }, 400);
    }

    const code = c.req.query("code");
    if (!code || c.req.query("state") !== pending.state) {
      return c.json({ error: "invalid callback" }, 400);
    }

    try {
      const { issuer } = await discover(cfg);
      const tokens = await exchangeCode(cfg, code, pending.verifier, pending.redirectUri);
      if (!tokens.id_token) throw new Error("no id_token in response");
      const claims = validateIdToken(issuer, cfg.clientId, tokens.id_token, pending.nonce);
      const info = await fetchUserInfo(cfg, tokens.access_token);

      const session: SessionData = {
        user: { ...claims, ...info, sub: claims.sub },
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      };
      setCookie(c, SID, await seal(cfg.sessionSecret, session), cookieOpts(isHttps(c), cfg.sessionTtlSeconds));
      // Best-effort: record the user in the directory + resolve pending invites.
      try {
        const u = session.user as { sub: string; email?: string; name?: string; picture?: string; email_verified?: boolean };
        await onLogin?.({ sub: u.sub, email: u.email, name: u.name, picture: u.picture, emailVerified: u.email_verified });
      } catch {
        /* directory upkeep must never block login */
      }
      return c.redirect(safeReturn(c, cfg, pending.returnTo));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.post("/logout", async (c) => {
    deleteCookie(c, SID, { path: "/" });
    return c.json({ ok: true });
  });

  return app;
}
