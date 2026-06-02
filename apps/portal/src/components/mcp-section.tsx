import { useEffect, useState } from "react";
import { Icon } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { fetchMe, listMcpConnections, type McpConnection } from "@/lib/api";

/** A connection is "active" if it was seen in the last 5 minutes (a live green dot). */
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

/** Human label for a connection: the handshake name, else the host of a CIMD client-id URL, else the raw id. */
function connectionLabel(c: McpConnection): string {
  if (c.name) return c.name;
  try {
    return new URL(c.clientId).host;
  } catch {
    return c.clientId;
  }
}

/** Coarse "x ago" for a timestamp relative to `now` — enough to convey freshness, no dependency. */
function timeAgo(iso: string, now: number): string {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const min = Math.round(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

/**
 * "AI assistants (MCP)" — connect Claude or ChatGPT to the drive over the Model
 * Context Protocol. We expose a remote MCP server at `/mcp` (see apps/api/src/mcp);
 * the assistant signs in as the user via OAuth and can then search, read, and
 * manage their files. This panel just hands the user the server URL and points
 * them at each assistant's connector settings — the OAuth handshake is theirs.
 *
 * Note on deep links: claude.ai / ChatGPT don't accept a pre-filled MCP URL via a
 * query param, so the flow is "open the connectors page, paste this URL". The
 * buttons open those pages; the URL above is what gets pasted.
 */
export function McpSection() {
  const [copied, setCopied] = useState(false);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [connections, setConnections] = useState<McpConnection[]>([]);
  // "now" captured when the connections load — keeps the relative-time render pure
  // (no Date.now() during render); the panel isn't long-lived, so it needn't tick.
  const [now, setNow] = useState(0);

  const mcpUrl = `${window.location.origin}/mcp`;

  // One-click install deep links. Editors accept the server config in the link
  // itself, so these genuinely install the connector (the OAuth sign-in happens on
  // first use). Cursor wants base64 JSON; VS Code wants URL-encoded JSON.
  const cursorUrl = `cursor://anysphere.cursor-deeplink/mcp/install?name=canopy-drive&config=${btoa(
    JSON.stringify({ url: mcpUrl }),
  )}`;
  const vscodeUrl = `vscode:mcp/install?${encodeURIComponent(
    JSON.stringify({ name: "canopy-drive", url: mcpUrl }),
  )}`;

  useEffect(() => {
    let alive = true;
    fetchMe()
      .then((me) => {
        if (!alive) return;
        setAuthRequired(me.authConfigured);
        setSignedIn(!!me.user);
      })
      .catch(() => alive && setSignedIn(null));
    // Which assistants have actually connected (empty when none / not signed in).
    listMcpConnections().then((c) => {
      if (!alive) return;
      setConnections(c);
      setNow(Date.now());
    });
    return () => {
      alive = false;
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(mcpUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  const open = (url: string) => window.open(url, "_blank", "noopener,noreferrer");
  // Only block when auth is configured but the user isn't signed in — in the
  // anonymous demo there's no account to connect as, but the URL is still valid.
  const needsSignIn = authRequired && signedIn === false;

  return (
    <section className="flex flex-col gap-4 rounded-xl border bg-card p-5">
      <div className="flex items-center gap-3">
        <div className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">
          <Icon name="globe" size={20} />
        </div>
        <div className="flex-1">
          <div className="text-[15px] font-semibold">AI assistants (MCP)</div>
          <div className="text-[12.5px] text-muted-foreground">
            Connect Claude or ChatGPT to your drive. They can search, read, and manage your files —
            signing in as you, with the same access you have.
          </div>
        </div>
      </div>

      {/* Server URL — what you paste into the assistant's connector settings. */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          MCP server URL
        </span>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 font-mono text-[12px] text-foreground">
            {mcpUrl}
          </code>
          <Button variant="ghost" size="sm" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>

      {needsSignIn && (
        <p className="rounded-lg bg-muted/60 px-3 py-2 text-[12.5px] text-muted-foreground">
          Sign in first — assistants connect as your account, so the link only works once you're
          signed in.
        </p>
      )}

      {/* Assistants — open the connector settings page; the URL above is pasted there. */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Assistants
        </span>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={needsSignIn} onClick={() => open("https://claude.ai/customize/connectors")}>
            <Icon name="link" size={14} />
            Add to Claude
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={needsSignIn}
            onClick={() => open("https://chatgpt.com/#settings/Connectors")}
          >
            <Icon name="link" size={14} />
            Add to ChatGPT
          </Button>
        </div>
      </div>

      {/* Connected — assistants that have actually reached the MCP server, with how
          recently. Recorded server-side per request (the MCP server is stateless). */}
      {connections.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Connected
          </span>
          <ul className="flex flex-col gap-1.5">
            {connections.map((conn) => {
              const active = now - new Date(conn.lastSeenAt).getTime() < ACTIVE_WINDOW_MS;
              return (
                <li
                  key={conn.clientId}
                  className="flex items-center gap-2.5 rounded-lg bg-muted/50 px-3 py-2 text-[12.5px]"
                >
                  <span
                    className={`size-2 shrink-0 rounded-full ${active ? "bg-green-500" : "bg-muted-foreground/40"}`}
                    title={active ? "Active recently" : "Idle"}
                  />
                  <span className="font-medium text-foreground">{connectionLabel(conn)}</span>
                  <span className="ml-auto text-muted-foreground">last active {timeAgo(conn.lastSeenAt, now)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Editors — true one-click installs via custom-scheme deep links. */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Editors · one-click install
        </span>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <a href={cursorUrl}>
              <Icon name="download" size={14} />
              Cursor
            </a>
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href={vscodeUrl}>
              <Icon name="download" size={14} />
              VS Code
            </a>
          </Button>
        </div>
      </div>

      <details className="group border-t pt-3 text-[12.5px] text-muted-foreground">
        <summary className="cursor-pointer select-none font-medium text-foreground">
          How to connect
        </summary>
        <div className="mt-2 flex flex-col gap-2 leading-relaxed">
          <p>
            <span className="font-medium text-foreground">Claude</span> — Customize →{" "}
            <span className="font-medium text-foreground">Connectors</span> →{" "}
            <span className="font-medium text-foreground">Add custom connector</span>, paste the URL
            above, then approve the sign-in. (Custom connectors require a Pro/Team/Enterprise plan.)
          </p>
          <p>
            <span className="font-medium text-foreground">ChatGPT</span> — Settings →{" "}
            <span className="font-medium text-foreground">Connectors</span> (enable it for use in
            chat / deep research), <span className="font-medium text-foreground">Add</span> the URL,
            then sign in. Exposes <code className="font-mono">search</code> and{" "}
            <code className="font-mono">fetch</code> for retrieval.
          </p>
        </div>
      </details>
    </section>
  );
}
