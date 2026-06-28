import { useEffect, useRef, useState } from "react";

/**
 * Sandboxed UI-slot host — the generalized sibling of {@link PluginViewer}.
 *
 * Where the viewer hands an untrusted plugin one file's bytes, a *slot* hands it
 * nothing by default: a plugin contributing a detail view or rail panel renders
 * into an `<iframe sandbox="allow-scripts">` with **no** `allow-same-origin` (a
 * unique opaque origin — no access to our DOM, cookies, storage, or same-origin
 * network) and reaches the host only through a narrow capability bridge.
 *
 * Two things cross the boundary, both mediated by the host:
 *   1. **Capabilities** — the plugin calls `ctx.call(method, params)` and the host
 *      fulfils it from the `capabilities` map (e.g. a credentialed `/api/calendar`
 *      fetch). The plugin can only invoke methods the host wired up; that map *is*
 *      the grant. RPC is correlated by id so calls can run concurrently.
 *   2. **Theme** — we read the host's resolved CSS custom properties and set them
 *      on the frame's root, so a plugin styling with `hsl(var(--primary))` etc.
 *      looks native without importing our component library.
 *
 * Protocol:
 *   iframe → host  { type: "canopy:slot-ready" }                    bootstrap listening
 *   host → iframe  { type: "canopy:init", code, slot, theme, dark } plugin source + context
 *   iframe → host  { type: "canopy:height", height }                auto-resize
 *   iframe → host  { type: "canopy:rendered" }                      slot mounted ok
 *   iframe → host  { type: "canopy:error", message }                load/render failed
 *   iframe → host  { type: "canopy:rpc", id, method, params }       capability call
 *   host → iframe  { type: "canopy:rpc-result", id, ok, result?, error? }
 *   iframe → host  { type: "canopy:action", action, data }          fire-and-forget event
 */

/** A host-fulfilled capability: the plugin calls it by name via `ctx.call`. */
export type CapabilityMap = Record<string, (params?: unknown) => Promise<unknown>>;

/** Host CSS custom properties mirrored into the sandbox so plugins look native. */
const THEME_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--muted-foreground",
  "--primary",
  "--primary-foreground",
  "--border",
  "--accent",
  "--accent-foreground",
  "--radius",
];

function readTheme(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const token of THEME_TOKENS) out[token] = cs.getPropertyValue(token).trim();
  return out;
}

const BOOTSTRAP = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  #root { font: 14px system-ui, -apple-system, sans-serif; color: hsl(var(--foreground)); }
</style>
</head>
<body>
<div id="root"></div>
<script type="module">
  const send = (msg, transfer) => parent.postMessage(msg, "*", transfer || []);
  let started = false;

  const reportHeight = () =>
    send({ type: "canopy:height", height: Math.ceil(document.documentElement.scrollHeight) });

  // Pending capability calls, keyed by request id.
  const pending = new Map();
  let nextId = 0;

  addEventListener("message", async (e) => {
    const msg = e.data;
    if (!msg) return;

    if (msg.type === "canopy:rpc-result") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || "capability call failed"));
      return;
    }

    if (msg.type !== "canopy:init" || started) return;
    started = true;

    // Mirror the host theme onto our root so hsl(var(--token)) resolves.
    for (const [k, v] of Object.entries(msg.theme || {})) document.documentElement.style.setProperty(k, v);
    document.documentElement.style.colorScheme = msg.dark ? "dark" : "light";

    try {
      const blob = new Blob([msg.code], { type: "text/javascript" });
      const url = URL.createObjectURL(blob);
      const mod = await import(url);
      URL.revokeObjectURL(url);
      const render = (msg.slot && mod[msg.slot]) || mod.default || mod.render;
      if (typeof render !== "function")
        throw new Error("plugin must export a render() for slot '" + msg.slot + "' (named export or default)");

      const call = (method, params) =>
        new Promise((resolve, reject) => {
          const id = ++nextId;
          pending.set(id, { resolve, reject });
          send({ type: "canopy:rpc", id, method, params });
        });

      await render({
        container: document.getElementById("root"),
        slot: msg.slot,
        call,
        emit: (action, data) => send({ type: "canopy:action", action, data }),
      });
      send({ type: "canopy:rendered" });
      reportHeight();
    } catch (err) {
      send({ type: "canopy:error", message: String((err && err.message) || err) });
    }
  });

  new ResizeObserver(reportHeight).observe(document.documentElement);
  send({ type: "canopy:slot-ready" });
</script>
</body>
</html>`;

type Status = "loading" | "ready" | "error";

/** Cheap, stable signature of a string — distinguishes one plugin source from another. */
function sig(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return `${s.length}.${h >>> 0}`;
}

/**
 * Mount a plugin-contributed UI slot in the sandbox.
 *
 * The iframe is keyed by `${plugin}:${slot}:${sig(source)}` so switching plugins
 * — or regenerating the same one with new source — remounts a fresh frame. This
 * is essential: `srcDoc` is static, so the `canopy:slot-ready` handshake fires
 * only on (re)load; without a remount a new `source` would never be initialised
 * and the old plugin would keep running. `capabilities` may change identity
 * between renders without re-initialising the frame — the latest map is read from
 * a ref when a call arrives — so the theme/source captured at init stay stable.
 */
export function PluginSlot({
  plugin,
  slot,
  source,
  capabilities,
  className,
}: {
  plugin: string;
  slot: string;
  source: string;
  capabilities: CapabilityMap;
  className?: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);

  const capsRef = useRef(capabilities);
  useEffect(() => {
    capsRef.current = capabilities;
  }, [capabilities]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let cancelled = false;

    async function onMessage(e: MessageEvent) {
      // Only trust messages from *this* iframe's window (opaque origin).
      if (e.source !== iframe?.contentWindow) return;
      const msg = e.data as {
        type?: string;
        height?: number;
        message?: string;
        id?: number;
        method?: string;
        params?: unknown;
      };

      if (msg?.type === "canopy:slot-ready") {
        iframe?.contentWindow?.postMessage(
          { type: "canopy:init", code: source, slot, theme: readTheme(), dark: document.documentElement.classList.contains("dark") },
          "*",
        );
      } else if (msg?.type === "canopy:height" && typeof msg.height === "number") {
        setHeight(Math.max(40, Math.min(msg.height, 4000)));
      } else if (msg?.type === "canopy:rendered") {
        setStatus("ready");
      } else if (msg?.type === "canopy:error") {
        setError(msg.message ?? "plugin error");
        setStatus("error");
      } else if (msg?.type === "canopy:rpc" && typeof msg.id === "number" && typeof msg.method === "string") {
        const reply = (ok: boolean, result?: unknown, err?: string) =>
          iframe?.contentWindow?.postMessage({ type: "canopy:rpc-result", id: msg.id, ok, result, error: err }, "*");
        const fn = capsRef.current[msg.method];
        if (!fn) return reply(false, undefined, `unknown capability: ${msg.method}`);
        try {
          const result = await fn(msg.params);
          if (!cancelled) reply(true, result);
        } catch (err) {
          if (!cancelled) reply(false, undefined, (err as Error).message);
        }
      }
    }

    window.addEventListener("message", onMessage);
    return () => {
      cancelled = true;
      window.removeEventListener("message", onMessage);
    };
  }, [plugin, slot, source]);

  if (status === "error") {
    return (
      <div className={className}>
        <div className="grid place-items-center rounded-lg border-2 border-dashed border-destructive/40 p-6 text-center text-[13px] text-muted-foreground">
          <div className="flex flex-col items-center gap-1.5">
            <span className="font-medium text-destructive">Plugin failed to load</span>
            <span className="font-mono text-[11.5px]">{error}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <iframe
      key={`${plugin}:${slot}:${sig(source)}`}
      ref={iframeRef}
      title={`${plugin} ${slot}`}
      // No allow-same-origin: the frame gets a unique opaque origin.
      sandbox="allow-scripts"
      srcDoc={BOOTSTRAP}
      className={className}
      style={{ width: "100%", border: 0, height, transition: "height 120ms ease" }}
    />
  );
}
