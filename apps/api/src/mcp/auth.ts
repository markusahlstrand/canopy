import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Caller } from "@canopy/store";
import type { AuthConfig } from "../auth/config";
import { discover } from "../auth/oidc";
import type { DriveDeps, MCPEnv } from "./index";

/**
 * The MCP endpoint is an OAuth 2.1 **Resource Server**: clients (Claude, ChatGPT)
 * arrive with an `Authorization: Bearer <JWT>` access token minted by the OIDC
 * provider (authhero). We verify the token's signature against the provider's
 * JWKS and check issuer + audience, then run the request as that user. This is a
 * different auth path than the browser's session cookie — bearer tokens, not
 * cookies — so MCP gets its own middleware rather than reusing `callerOf`.
 *
 * When no token (or an invalid one) is presented we answer `401` with a
 * `WWW-Authenticate` challenge that points at our Protected Resource Metadata
 * (RFC 9728); that's what kicks the client into the discovery + OAuth flow.
 */

// One remote JWKS per issuer, cached at module scope. `jose` fetches the keys
// lazily and refetches on an unknown `kid`, so this is safe to keep forever.
const jwksByIssuer = new Map<string, JWTVerifyGetKey>();

async function jwksFor(cfg: AuthConfig): Promise<{ jwks: JWTVerifyGetKey; issuer: string }> {
  const doc = await discover(cfg);
  if (!doc.jwks_uri) throw new Error("OIDC provider exposes no jwks_uri");
  let jwks = jwksByIssuer.get(doc.issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(doc.jwks_uri));
    jwksByIssuer.set(doc.issuer, jwks);
  }
  return { jwks, issuer: doc.issuer };
}

export function mcpAuth(authConfig: AuthConfig | null, drive: DriveDeps | undefined): MiddlewareHandler<MCPEnv> {
  return async (c, next) => {
    // Auth not configured (dev / anonymous demo): run as the shared "demo" user,
    // mirroring `callerOf` in app.ts so the public demo MCP works without sign-in.
    if (!authConfig) {
      c.set("mcpCaller", { sub: "demo", email: "", emailVerified: false });
      return next();
    }

    const origin = authConfig.appBaseUrl ?? new URL(c.req.url).origin;
    const challenge = (error?: string) => {
      const parts = [`resource_metadata="${origin}/.well-known/oauth-protected-resource"`];
      if (error) parts.unshift(`error="${error}"`);
      c.header("WWW-Authenticate", `Bearer ${parts.join(", ")}`);
    };

    const header = c.req.header("Authorization");
    if (!header?.startsWith("Bearer ")) {
      challenge();
      return c.json({ error: "unauthorized" }, 401);
    }

    try {
      const { jwks, issuer } = await jwksFor(authConfig);
      const { payload } = await jwtVerify(header.slice("Bearer ".length).trim(), jwks, {
        issuer,
        audience: authConfig.audience ?? "urn:canopy",
      });
      if (!payload.sub) throw new Error("token has no subject");
      const caller: Caller = {
        sub: String(payload.sub),
        email: typeof payload.email === "string" ? payload.email : "",
        emailVerified: payload.email_verified === true || payload.email_verified === "true",
      };
      // Backfill the user directory (same as the session path) so sharing and
      // personal-space resolution work for a token-only caller.
      if (drive) await drive.service.ensureUser({ sub: caller.sub, email: caller.email });
      c.set("mcpCaller", caller);
      return next();
    } catch {
      challenge("invalid_token");
      return c.json({ error: "invalid_token" }, 401);
    }
  };
}
