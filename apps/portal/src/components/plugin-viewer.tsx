import { useEffect, useRef, useState } from "react";
import { fetchContent } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

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
 *
 * Saving (editors): a plugin requests a write by emitting `action: "save"` with
 * `{ content }`. The host writes it back — but only to the file currently being
 * previewed (`file.url`), never a path the plugin chooses — and reports the
 * outcome. That's the write half of the capability handoff.
 *
 *   iframe → host  { type: "canopy:action", action: "save", data: { content } }
 *   host → iframe  { type: "canopy:save-result", ok, error? }
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
  let fillMode = false;

  const reportHeight = () => {
    if (fillMode) return; // fill viewers (e.g. images) are sized by the host, not by their content
    send({ type: "canopy:height", height: Math.ceil(document.documentElement.scrollHeight) });
  };

  addEventListener("message", async (e) => {
    const msg = e.data;
    if (!msg || msg.type !== "canopy:init" || started) return;
    started = true;
    fillMode = !!msg.fill;
    if (fillMode) {
      // The host has sized our iframe to the available space — fill it instead of
      // growing to fit the content (that loop is what made images shrink away).
      document.documentElement.style.height = "100%";
      document.body.style.height = "100%";
      const r = document.getElementById("root");
      r.style.height = "100%";
      r.style.boxSizing = "border-box";
      r.style.display = "flex";
      r.style.alignItems = "center";
      r.style.justifyContent = "center";
    }
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
        fill: fillMode,
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
  /** The space token the file belongs to, so its cached bytes count against that
   *  space's offline budget. Optional — connector URLs carry it intrinsically. */
  spaceId?: string;
}

type Status = "loading" | "ready" | "error";

/**
 * Mount with a `key` tied to the file (e.g. `key={file.url}`) so a new file
 * remounts the component — the iframe and its state reset cleanly per file.
 *
 * `writable` lets an editor plugin save back to this file; `onSaved` fires after
 * a successful write so the host can refresh metadata.
 */
export function PluginViewer({
  file,
  className,
  fill,
  onSaved,
  onSaveContent,
}: {
  file: ViewerFile;
  className?: string;
  /** Size the iframe to fill its parent (height 100%) instead of auto-growing to fit content. */
  fill?: boolean;
  onSaved?: () => void;
  /** When provided, the viewer can save: the host persists the edited text (as a new version). */
  onSaveContent?: (content: string) => Promise<void>;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(240);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const writable = !!onSaveContent;

  // Keep the latest callbacks without making them deps — a new identity each
  // parent render would otherwise re-init the iframe (and reset an open editor).
  const cbRef = useRef({ onSaved, onSaveContent });
  useEffect(() => {
    cbRef.current = { onSaved, onSaveContent };
  }, [onSaved, onSaveContent]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    let cancelled = false;

    async function onMessage(e: MessageEvent) {
      // Only trust messages from *this* iframe's window (origin is "null" / opaque).
      if (e.source !== iframe?.contentWindow) return;
      const msg = e.data as {
        type?: string;
        height?: number;
        message?: string;
        action?: string;
        data?: { content?: string };
      };
      if (msg?.type === "canopy:viewer-ready") {
        try {
          const { bytes, mime } = await fetchContent(file.url, file.spaceId);
          if (cancelled) return;
          iframe?.contentWindow?.postMessage(
            { type: "canopy:init", code: file.source, file: { name: file.name, mime, bytes, writable }, fill },
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
      } else if (msg?.type === "canopy:action" && msg.action === "save") {
        // The host persists the edited text (a new version), scoped to THIS file.
        const reply = (ok: boolean, err?: string) =>
          iframe?.contentWindow?.postMessage({ type: "canopy:save-result", ok, error: err }, "*");
        const save = cbRef.current.onSaveContent;
        if (!save) return reply(false, "this file is read-only");
        try {
          await save(msg.data?.content ?? "");
          if (cancelled) return;
          reply(true);
          cbRef.current.onSaved?.();
        } catch (err) {
          if (!cancelled) reply(false, (err as Error).message);
        }
      }
    }

    window.addEventListener("message", onMessage);
    return () => {
      cancelled = true;
      window.removeEventListener("message", onMessage);
    };
  }, [file.url, file.source, file.name, file.spaceId, writable, fill]);

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
    <div className={cn(className, "relative", fill && "h-full w-full min-h-0")}>
      {/* The iframe stays mounted (it drives the load over postMessage); the skeleton
          just covers its blank phase until the plugin reports `rendered`. */}
      {status === "loading" && (
        <div
          className={cn("absolute inset-0 z-10 overflow-hidden rounded-lg border bg-background p-4")}
          aria-hidden
        >
          <ViewerSkeleton fill={fill} />
        </div>
      )}
      <iframe
        ref={iframeRef}
        title="File preview"
        // No allow-same-origin: the frame gets a unique opaque origin.
        sandbox="allow-scripts"
        srcDoc={BOOTSTRAP}
        className={cn("w-full rounded-lg border bg-background", fill && "h-full")}
        style={fill ? undefined : { height, transition: "height 120ms ease" }}
      />
    </div>
  );
}

/** Placeholder shown while a viewer loads: a page shape (title + paragraphs) for
 *  text-ish viewers, or one filling block for `fill` viewers (images, media). */
function ViewerSkeleton({ fill }: { fill?: boolean }) {
  if (fill) return <Skeleton className="h-full w-full rounded-md" />;
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-5 w-1/3" />
      <div className="mt-1 flex flex-col gap-2.5">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-[92%]" />
        <Skeleton className="h-3 w-[97%]" />
        <Skeleton className="h-3 w-[78%]" />
      </div>
    </div>
  );
}
