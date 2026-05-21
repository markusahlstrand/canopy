export interface AuthConfig {
  /** Discovery host — where /.well-known/openid-configuration lives. */
  issuer: string;
  clientId: string;
  /** Omitted for public (PKCE-only) clients. */
  clientSecret?: string;
  /** API audience (Auth0/authhero) — the access token is minted for this. */
  audience?: string;
  /** Optional override; otherwise derived from the request origin. */
  redirectUri?: string;
  scopes: string;
  /** Optional override for post-login redirects; otherwise the request origin.
   *  Needed in dev because Vite proxies /api to a different port. */
  appBaseUrl?: string;
  sessionTtlSeconds: number;
  /** Key for encrypting the session cookie (AES-GCM). */
  sessionSecret: string;
}

export type EnvVars = Record<string, string | undefined>;

function defaultEnv(): EnvVars {
  // process exists on Node; on Workers config comes from the fetch `env` arg.
  const p = (globalThis as { process?: { env?: EnvVars } }).process;
  return p?.env ?? {};
}

/**
 * Read auth config from an environment bag. Defaults to process.env (Node);
 * the Cloudflare Worker passes its `env` binding object instead. Returns null
 * when auth isn't configured.
 */
export function readAuthConfig(env: EnvVars = defaultEnv()): AuthConfig | null {
  const issuer = env.OIDC_ISSUER;
  const clientId = env.OIDC_CLIENT_ID;
  if (!issuer || !clientId) return null;

  return {
    issuer: issuer.replace(/\/$/, ""),
    clientId,
    clientSecret: env.OIDC_CLIENT_SECRET || undefined,
    audience: env.OIDC_AUDIENCE || undefined,
    redirectUri: env.OIDC_REDIRECT_URI || undefined,
    scopes: env.OIDC_SCOPES ?? "openid profile email offline_access",
    appBaseUrl: env.APP_BASE_URL || undefined,
    sessionTtlSeconds: Number(env.SESSION_TTL ?? 60 * 60 * 24 * 30),
    sessionSecret: env.SESSION_SECRET || "",
  };
}
