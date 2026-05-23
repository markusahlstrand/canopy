import type { AuthConfig } from "./config";

export interface UserProfile {
  sub: string;
  email?: string;
  /** Whether the IdP asserts the email is verified — gates claiming email-bound invites. */
  emailVerified?: boolean;
  name?: string;
  picture?: string;
}

/** OIDC `email_verified` may arrive as a boolean or (some IdPs) the string "true". */
const emailVerified = (v: unknown): boolean => v === true || v === "true";

interface Discovery {
  /** The issuer identifier — what id_token `iss` claims must match. May differ
   *  from the discovery host (e.g. discovery on auth2.sesamy.dev, iss token.sesamy.dev). */
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(byteLength = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** PKCE S256 challenge for a given verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

let discoveryCache: { issuer: string; doc: Discovery } | null = null;

export async function discover(cfg: AuthConfig): Promise<Discovery> {
  if (discoveryCache?.issuer === cfg.issuer) return discoveryCache.doc;
  const res = await fetch(`${cfg.issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const doc = (await res.json()) as Discovery;
  discoveryCache = { issuer: cfg.issuer, doc };
  return doc;
}

export async function buildAuthorizeUrl(
  cfg: AuthConfig,
  params: { state: string; nonce: string; codeChallenge: string; redirectUri: string },
): Promise<string> {
  const { authorization_endpoint } = await discover(cfg);
  const url = new URL(authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", cfg.scopes);
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (cfg.audience) url.searchParams.set("audience", cfg.audience);
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type: string;
}

export async function exchangeCode(
  cfg: AuthConfig,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const { token_endpoint } = await discover(cfg);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: cfg.clientId,
    code_verifier: codeVerifier,
  });
  // authhero treats PKCE (code_verifier) and client_secret as mutually exclusive
  // at the token endpoint. We always use PKCE, so the secret is only sent for a
  // non-PKCE confidential flow (codeVerifier absent).
  if (cfg.clientSecret && !codeVerifier) body.set("client_secret", cfg.clientSecret);
  // NOTE: `audience` is NOT accepted on the authorization_code token request —
  // it's set on /authorize (buildAuthorizeUrl), which binds the code to it.
  const res = await fetch(token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as TokenResponse;
}

export async function refreshTokens(cfg: AuthConfig, refreshToken: string): Promise<TokenResponse> {
  const { token_endpoint } = await discover(cfg);
  // Public/PKCE client: the refresh token itself is the credential — no secret.
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: cfg.clientId,
  });
  if (cfg.audience) body.set("audience", cfg.audience);
  const res = await fetch(token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`token refresh failed: ${res.status}`);
  return (await res.json()) as TokenResponse;
}

/** Decode a JWT payload (no signature check — see validateIdToken). */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("malformed id_token");
  const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(json) as Record<string, unknown>;
}

/**
 * Validate id_token claims against the *discovered* issuer (which may differ
 * from the discovery host). Signature verification is intentionally omitted:
 * the token arrives over the back-channel TLS connection to the issuer's token
 * endpoint, which OIDC permits skipping JWKS for. (JWKS verification is a
 * worthwhile hardening step — tracked separately.)
 */
export function validateIdToken(
  expectedIssuer: string,
  clientId: string,
  idToken: string,
  expectedNonce: string,
): UserProfile {
  const c = decodeJwtPayload(idToken);
  const iss = String(c.iss ?? "").replace(/\/$/, "");
  if (iss !== expectedIssuer.replace(/\/$/, "")) throw new Error("id_token issuer mismatch");
  const aud = c.aud;
  const audOk = Array.isArray(aud) ? aud.includes(clientId) : aud === clientId;
  if (!audOk) throw new Error("id_token audience mismatch");
  if (typeof c.exp === "number" && c.exp * 1000 < Date.now()) throw new Error("id_token expired");
  if (c.nonce && c.nonce !== expectedNonce) throw new Error("id_token nonce mismatch");
  return {
    sub: String(c.sub),
    email: typeof c.email === "string" ? c.email : undefined,
    emailVerified: emailVerified(c.email_verified),
    name: typeof c.name === "string" ? c.name : undefined,
    picture: typeof c.picture === "string" ? c.picture : undefined,
  };
}

export async function fetchUserInfo(cfg: AuthConfig, accessToken: string): Promise<Partial<UserProfile>> {
  const { userinfo_endpoint } = await discover(cfg);
  if (!userinfo_endpoint) return {};
  const res = await fetch(userinfo_endpoint, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return {};
  const u = (await res.json()) as Record<string, unknown>;
  return {
    email: typeof u.email === "string" ? u.email : undefined,
    // Only assert verified when userinfo actually carries the claim — otherwise we'd
    // clobber a `true` from the id_token when this gets merged over the claims.
    ...("email_verified" in u ? { emailVerified: emailVerified(u.email_verified) } : {}),
    name: typeof u.name === "string" ? u.name : undefined,
    picture: typeof u.picture === "string" ? u.picture : undefined,
  };
}
