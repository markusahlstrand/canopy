import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PluginHostProvider } from "@canopy/plugin-sdk";
import { ModelEditorFileRouter } from "@canopy/model-editor";
import { createHostBridge } from "./host-bridge";
import { applyTheme } from "./theme";
import type { HostMethod, HostToWebview, WebviewToHost } from "../src/messages";
import "./index.css";

declare function acquireVsCodeApi(): { postMessage(msg: WebviewToHost): void };
const vscode = acquireVsCodeApi();

// Correlate HostBridge calls with their responses by id.
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
function call(method: HostMethod, payload: unknown): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    vscode.postMessage({ type: "request", id, method, payload });
  });
}
const bridge = createHostBridge(call);

type FileMeta = { fileName: string; fsPath: string; dir: string };

function App() {
  const [meta, setMeta] = useState<FileMeta | null>(null);
  // Bumped on external edits to remount the canvas, which re-reads the file.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const onMessage = (e: MessageEvent<HostToWebview>) => {
      const msg = e.data;
      switch (msg.type) {
        case "init":
          applyTheme(msg.dark);
          setMeta({ fileName: msg.fileName, fsPath: msg.fsPath, dir: msg.dir });
          break;
        case "externalChange":
          setReloadKey((k) => k + 1);
          break;
        case "theme":
          applyTheme(msg.dark);
          break;
        case "response": {
          const entry = pending.get(msg.id);
          if (!entry) return;
          pending.delete(msg.id);
          if (msg.ok) entry.resolve(msg.result);
          else entry.reject(new Error(msg.error));
          break;
        }
      }
    };
    window.addEventListener("message", onMessage);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (!meta) {
    return <div className="grid h-full place-items-center text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <PluginHostProvider value={bridge}>
      <div className="h-full bg-background text-foreground">
        <ModelEditorFileRouter
          key={`${meta.fsPath}:${reloadKey}`}
          fileId={meta.fsPath}
          fileName={meta.fileName}
          filePath={meta.dir}
        />
      </div>
    </PluginHostProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
