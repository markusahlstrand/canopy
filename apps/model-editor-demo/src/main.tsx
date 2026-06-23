import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PluginHostProvider } from "@canopy/plugin-sdk";
import { ModelEditorFileRouter, SAMPLE_PROJECT, SAMPLE_ENTRYPOINT } from "@canopy/model-editor";
import { Icon } from "@canopy/ui";
import type { PluginFile } from "@canopy/plugin-sdk";
import { createFsHostBridge } from "./fs-host-bridge";
import { createSampleBridge } from "./sample-bridge";
import "./index.css";

/** The file kinds the Model Editor claims, used to populate the sidebar. */
const SUPPORTED = /\.(prisma|tsp|(arazzo|asyncapi)(\.(ya?ml|json))?)$/i;

type Entry = { id: string; name: string; dir: string };

// The shared Pet Store sample, as sidebar entries (root-level, openable kinds only).
// `openapi.yaml` is omitted here — it isn't directly openable but is still served by
// the sample bridge so the spec editor discovers it as a sibling.
const SAMPLE_ENTRIES: Entry[] = SAMPLE_PROJECT.filter((f) => SUPPORTED.test(f.name)).map((f) => ({
  id: f.name,
  name: f.name,
  dir: "",
}));

/** Recursively collect supported model files under a folder, skipping noise. */
async function walk(handle: FileSystemDirectoryHandle, dir = "", depth = 0): Promise<Entry[]> {
  if (depth > 6) return [];
  const out: Entry[] = [];
  for await (const [name, entry] of handle.entries()) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const path = dir ? `${dir}/${name}` : name;
    if (entry.kind === "directory") {
      out.push(...(await walk(entry, path, depth + 1)));
    } else if (SUPPORTED.test(name)) {
      out.push({ id: path, name, dir });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function App() {
  const [root, setRoot] = useState<FileSystemDirectoryHandle | null>(null);
  const [sample, setSample] = useState(false);
  const [files, setFiles] = useState<Entry[]>([]);
  const [open, setOpen] = useState<Entry | null>(null);
  const [dark, setDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  const [error, setError] = useState<string | null>(null);
  // Kept in a ref so the (stable) bridge always sees the current root handle.
  const rootRef = useRef<FileSystemDirectoryHandle | null>(null);
  rootRef.current = root;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  const openEntry = useCallback((file: PluginFile) => {
    setOpen({ id: file.id, name: file.name, dir: file.path ?? "" });
  }, []);

  // One bridge instance for the app's lifetime; it reads the live root via the ref.
  const fsBridge = useMemo(() => createFsHostBridge(() => rootRef.current, openEntry), [openEntry]);
  const sampleBridge = useMemo(() => createSampleBridge(), []);
  const bridge = sample ? sampleBridge : fsBridge;

  const loadSample = useCallback(() => {
    setRoot(null);
    setFiles(SAMPLE_ENTRIES);
    // Open the contract first — it drives every tab in the spec workspace.
    setOpen(SAMPLE_ENTRIES.find((f) => f.name === SAMPLE_ENTRYPOINT) ?? SAMPLE_ENTRIES[0] ?? null);
    setSample(true);
  }, []);

  const pickFolder = useCallback(async () => {
    setError(null);
    try {
      const handle = await window.showDirectoryPicker({ id: "canopy-model-editor", mode: "readwrite" });
      const found = await walk(handle);
      setSample(false);
      setRoot(handle);
      setFiles(found);
      setOpen(found[0] ?? null);
    } catch (e) {
      // The user dismissing the picker throws AbortError — not worth surfacing.
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Couldn't open that folder");
    }
  }, []);

  const supported = typeof window !== "undefined" && "showDirectoryPicker" in window;
  const active = root !== null || sample;

  return (
    <PluginHostProvider value={bridge}>
      <div className="flex h-full flex-col bg-background text-foreground">
        <header className="flex items-center gap-3 border-b px-4 py-2">
          <Icon name="database" size={18} className="text-primary" />
          <span className="text-sm font-medium">Canopy Model Editor</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">local demo</span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={pickFolder}
              disabled={!supported}
              title={supported ? undefined : "Your browser doesn't support opening local folders"}
              className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Icon name="folder" size={14} />
              {root ? "Change folder" : "Open folder"}
            </button>
            <button
              onClick={() => setDark((d) => !d)}
              aria-label="Toggle theme"
              className="inline-flex items-center rounded-md border p-1.5 hover:bg-accent"
            >
              <Icon name={dark ? "sun" : "moon"} size={14} />
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          {active && (
            <aside className="w-60 shrink-0 overflow-y-auto border-r p-2">
              {files.length === 0 ? (
                <p className="p-2 text-xs text-muted-foreground">
                  No <code>.prisma</code>, <code>.tsp</code>, <code>.arazzo</code> or <code>.asyncapi</code> files in this folder.
                </p>
              ) : (
                <ul className="space-y-0.5">
                  {files.map((f) => (
                    <li key={f.id}>
                      <button
                        onClick={() => setOpen(f)}
                        title={f.id}
                        className={`flex w-full items-center gap-1.5 truncate rounded px-2 py-1 text-left text-sm hover:bg-accent ${
                          open?.id === f.id ? "bg-accent font-medium" : ""
                        }`}
                      >
                        <Icon name="file-text" size={14} className="shrink-0 text-muted-foreground" />
                        <span className="truncate">{f.dir ? `${f.dir}/${f.name}` : f.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </aside>
          )}

          <main className="min-w-0 flex-1">
            {!active && !supported ? (
              <Centered>
                <div className="max-w-sm space-y-3 text-center">
                  <p>The File System Access API isn't available in this browser. Try Chrome, Edge or Arc — or explore a sample.</p>
                  <button
                    onClick={loadSample}
                    className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
                  >
                    <Icon name="sparkles" size={14} />
                    Try a sample
                  </button>
                </div>
              </Centered>
            ) : !active ? (
              <Centered>
                <div className="max-w-sm space-y-3 text-center">
                  <p>Open a folder containing <code>.prisma</code>, <code>.tsp</code>, <code>.arazzo</code> or <code>.asyncapi</code> files to edit them visually.</p>
                  <div className="flex items-center justify-center gap-2">
                    <button
                      onClick={pickFolder}
                      className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
                    >
                      <Icon name="folder" size={14} />
                      Open folder
                    </button>
                    <button
                      onClick={loadSample}
                      className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
                    >
                      <Icon name="sparkles" size={14} />
                      Try a sample
                    </button>
                  </div>
                  {error && <p className="text-xs text-destructive">{error}</p>}
                </div>
              </Centered>
            ) : open ? (
              <ModelEditorFileRouter key={open.id} fileId={open.id} fileName={open.name} filePath={open.dir} />
            ) : (
              <Centered>Select a file to start editing.</Centered>
            )}
          </main>
        </div>
      </div>
    </PluginHostProvider>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-items-center p-6 text-sm text-muted-foreground">{children}</div>;
}

createRoot(document.getElementById("root")!).render(<App />);
