import { useCallback, useEffect, useState } from "react";
import { fetchFileText, getFile, listFiles } from "@/lib/api";
import { Icon } from "@/lib/icons";
import type { FileViewProps } from "@/plugins";
import { buildProjectGraph } from "./build-graph";
import { discoverProject, type SpecFileRef } from "./discover";
import type { ProjectGraph } from "./graph-types";
import { SpecEditorView } from "./spec-editor-view";

const parentDir = (p: string) => {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
};

/**
 * Bridges a stored `.tsp`/`.arazzo` file to the spec editor: it reads the opened
 * file, scans its folder for the related contract/workflow/openapi files, builds the
 * cross-layer project graph, and renders the three-tab workspace over it. Read-only
 * for now — write-back to the text files is a later phase.
 */
export function SpecFileViewer({ fileId, fileName, spaceId, filePath }: FileViewProps) {
  const [graph, setGraph] = useState<ProjectGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setGraph(null);
    setError(null);
    (async () => {
      const text = await fetchFileText(fileId);

      // Resolve the containing folder + space so we can list sibling files. Prefer the
      // values the host already has; fall back to a metadata lookup.
      let dir = filePath != null ? parentDir(filePath) : "";
      let space = spaceId;
      if (filePath == null) {
        const meta = await getFile(fileId);
        if (meta) dir = parentDir(meta.path ?? "");
      }

      const siblings = await listFiles(dir, space).catch(() => []);
      const refs: SpecFileRef[] = siblings
        .filter((f) => f.kind !== "folder")
        .map((f) => ({ id: f.id, name: f.name, path: f.path ?? "" }));

      const files = await discoverProject({ id: fileId, name: fileName, path: filePath, text }, { siblings: refs, readText: (r) => fetchFileText(r.id) });
      const built = await buildProjectGraph(files);
      if (alive) setGraph(built);
    })().catch((e) => alive && setError(e instanceof Error ? e.message : "Failed to load"));

    return () => {
      alive = false;
    };
  }, [fileId, fileName, spaceId, filePath, nonce]);

  if (error) {
    return <div className="grid h-full min-h-[200px] place-items-center text-sm text-muted-foreground">Couldn't load this spec: {error}</div>;
  }
  if (!graph) {
    return (
      <div className="grid h-full min-h-[200px] place-items-center text-muted-foreground">
        <Icon name="refresh" size={20} className="animate-spin" />
      </div>
    );
  }
  return <SpecEditorView graph={graph} fileName={fileName} onReload={reload} reloading={false} />;
}
