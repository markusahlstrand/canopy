import { Hono } from "hono";
import type { BlobStore, Caller, FileService } from "@canopy/store";
import type { AuthConfig } from "../auth/config";
import { discover } from "../auth/oidc";
import { mcpAuth } from "./auth";
import { handleMcp } from "./transport";

/** The DB-backed drive (same shape as app.ts's DriveDeps; re-declared to avoid a
 * runtime import cycle with app.ts). */
export interface DriveDeps {
  service: FileService;
  blobs: BlobStore;
}

/** Hono environment for the MCP routes — the verified caller is stashed here by `mcpAuth`. */
export type MCPEnv = { Variables: { mcpCaller: Caller } };

/**
 * Mount the remote MCP server (Model Context Protocol over Streamable HTTP) so
 * Claude and ChatGPT can search, read, and manage the drive.
 *
 *   • POST /mcp                                  — the JSON-RPC tool endpoint (bearer-protected)
 *   • GET  /.well-known/oauth-protected-resource — RFC 9728 metadata pointing clients at the OIDC provider
 *
 * Auth is OAuth 2.1 with the OIDC provider (authhero) as the Authorization
 * Server; this app is purely a Resource Server (see {@link mcpAuth}). Mounted at
 * the root so both paths sit outside `/api`. Both must be added to
 * `assets.run_worker_first` in wrangler.jsonc, or Static Assets answer them first.
 */
export function registerMcp(app: Hono, deps: { drive: DriveDeps; authConfig: AuthConfig | null }): void {
  const mcp = new Hono<MCPEnv>();

  mcp.get("/.well-known/oauth-protected-resource", async (c) => {
    const origin = deps.authConfig?.appBaseUrl ?? new URL(c.req.url).origin;
    // Advertise the AS issuer *exactly* as the provider declares it in discovery
    // (trailing slash and all). MCP clients reject AS metadata whose `issuer` doesn't
    // byte-match the value they built the well-known URL from, so we can't hand them
    // the trailing-slash-stripped `authConfig.issuer` — we echo the discovered one.
    let issuer = deps.authConfig?.issuer ?? "https://canopy.token.sesamy.dev";
    if (deps.authConfig) {
      try {
        issuer = (await discover(deps.authConfig)).issuer;
      } catch {
        /* provider unreachable — fall back to the configured issuer */
      }
    }
    return c.json({
      resource: `${origin}/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
    });
  });

  mcp.post("/mcp", mcpAuth(deps.authConfig, deps.drive), (c) => handleMcp(c, deps.drive));

  // Some clients probe these; a clear 405 beats the SPA's catch-all 404.
  mcp.on(["GET", "DELETE"], "/mcp", (c) => {
    c.header("Allow", "POST");
    return c.json({ error: "method not allowed" }, 405);
  });

  app.route("/", mcp);
}
