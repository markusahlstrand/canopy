import { useEffect, useRef, useState } from "react";

/**
 * Sandboxed file-viewer host.
 *
 * Plugin viewer code is untrusted, so it runs inside an `<iframe sandbox="allow-scripts">`
 * with **no** `allow-same-origin` — that gives the frame a unique *opaque origin*
 * (it can't touch our DOM, cookies, localStorage, or make same-origin requests).
 * The frame's document comes from `srcdoc` (a tiny bootstrap), so there's no
 * second domain to host.
 *
 * The host does the privileged work — it fetches the previewed file's bytes from
 * our API — and hands the iframe *only* that one file over `postMessage`
 * (transferring the ArrayBuffer). That's the whole capability: a plugin sees the
 * file it's previewing and nothing else.
 *
 * Protocol:
 *   iframe → host  { type: "canopy:viewer-ready" }            bootstrap is listening
 *   host → iframe  { type: "canopy:init", code, file }        plugin source + the file
 *   iframe → host  { type: "canopy:height", height }          auto-resize
 *   iframe → host  { type: "canopy:rendered" }                viewer mounted ok
 *   iframe → host  { type: "canopy:error", message }          load/render failed
 *   iframe → host  { type: "canopy:action", action, data }    plugin-emitted event
 */

const BOOTSTRAP = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  #root { padding: 12px; font: 14px system-ui, -apple-system, sans-serif; color: #111; }
  @media (prefers-color-scheme: dark) { #root { color: #e5e7eb; } }
</style>
</head>
<body>
<div id="root"></div>
<script type="module">
  const send = (msg, transfer) => parent.postMessage(msg, "*", transfer || []);
  let started = false;

  const reportHeight = () =>
    send({ type: "canopy:height", height: Math.ceil(document.documentElement.scrollHeight) });

  addEventListener("message", async (e) => {
    const msg = e.data;
    if (!msg || msg.type !== "canopy:init" || started) return;
    started = true;
    try {
      const blob = new Blob([msg.code], { type: "text/javascript" });
      const url = URL.createObjectURL(blob);
      const mod = await import(url);
      URL.revokeObjectURL(url);
      const render = mod.default || mod.render;
      if (typeof render !== "function") throw new Error("viewer must export a default render() function");
      const root = document.getElementById("root");
      await render({
        container: root,
        file: msg.file,
        emit: (action, data) => send({ type: "canopy:action", action, data }),
      });
      send({ type: "canopy:rendered" });
      reportHeight();
    } catch (err) {
      send({ type: "canopy:error", message: String((err && err.message) || err) });
    }
  });

  new ResizeObserver(reportHeight).observe(document.documentElement);
  send({ type: "canopy:viewer-ready" });
</script>
</body>
</html>`;

export interface ViewerFile {
  /** Source code (ESM) of the viewer plugin's entry module. */
  source: string;
  /** Display name of the file being previewed. */
  name: string;
  /** URL to fetch the file's bytes from (host-privileged). */
  url: string;
}

type Status = "loading" | "ready" | "error";

/**
 * Mount with a `key` tied to the file (e.g. `key={file.url}`) so a new file
 * remounts the component — the iframe and its state reset cleanly per file.
 */
export function PluginViewer({ file, className }: { file: ViewerFile; className?: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(240);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    let cancelled = false;

    async function onMessage(e: MessageEvent) {
      // Only trust messages from *this* iframe's window (origin is "null" / opaque).
      if (e.source !== iframe?.contentWindow) return;
      const msg = e.data as { type?: string; height?: number; message?: string };
      if (msg?.type === "canopy:viewer-ready") {
        try {
          const res = await fetch(file.url);
          if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
          const bytes = await res.arrayBuffer();
          const mime = res.headers.get("content-type") ?? "application/octet-stream";
          if (cancelled) return;
          iframe?.contentWindow?.postMessage(
            { type: "canopy:init", code: file.source, file: { name: file.name, mime, bytes } },
            "*",
            [bytes],
          );
        } catch (err) {
          if (!cancelled) {
            setError((err as Error).message);
            setStatus("error");
          }
        }
      } else if (msg?.type === "canopy:height" && typeof msg.height === "number") {
        setHeight(Math.max(120, Math.min(msg.height, 1600)));
      } else if (msg?.type === "canopy:rendered") {
        setStatus("ready");
      } else if (msg?.type === "canopy:error") {
        setError(msg.message ?? "viewer error");
        setStatus("error");
      }
    }

    window.addEventListener("message", onMessage);
    return () => {
      cancelled = true;
      window.removeEventListener("message", onMessage);
    };
  }, [file.url, file.source, file.name]);

  if (status === "error") {
    return (
      <div className={className}>
        <div className="grid h-52 place-items-center rounded-lg border-2 border-dashed border-destructive/40 text-center text-[13px] text-muted-foreground">
          <div className="flex flex-col items-center gap-1.5 px-6">
            <span className="font-medium text-destructive">Viewer failed to load</span>
            <span className="font-mono text-[11.5px]">{error}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <iframe
        ref={iframeRef}
        title="File preview"
        // No allow-same-origin: the frame gets a unique opaque origin.
        sandbox="allow-scripts"
        srcDoc={BOOTSTRAP}
        className="w-full rounded-lg border bg-background"
        style={{ height, transition: "height 120ms ease" }}
      />
    </div>
  );
}
