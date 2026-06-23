import { useCallback, useEffect, useState } from "react";
import { Icon } from "@canopy/ui";
import { usePluginHost, type FileViewProps } from "@canopy/plugin-sdk";
import { buildProjectGraph } from "./build-graph";
import { discoverProject, type SpecFileRef } from "./discover";
import type { ProjectGraph } from "./graph-types";
import { SIDECAR_NAME } from "./layout-sidecar";
import { SpecEditorView } from "./spec-editor-view";
import type { CommitLayoutFn } from "./use-layout";

/**
 * Bridges a stored `.tsp`/`.arazzo` file to the spec editor: it reads the opened
 * file, scans its folder for the related contract/workflow/openapi files, builds the
 * cross-layer project graph, and renders the spec workspace over it. Read-only
 * for now — write-back to the text files is a later phase.
 */
export function SpecFileViewer({ fileId, fileName, spaceId, filePath }: FileViewProps) {
  const host = usePluginHost();
  const [graph, setGraph] = useState<ProjectGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectKey, setProjectKey] = useState("");
  // Folder the spec lives in, resolved on load — the target for committing the sidecar.
  const [project, setProject] = useState<{ dir: string; space?: string } | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // Writes canopy.layout.json back to the repo (connector-aware): updates the existing
  // sidecar version, or creates it in the folder when there isn't one yet.
  const commitLayout = useCallback<CommitLayoutFn>(
    async (text, layoutFileId) => {
      if (!project) throw new Error("Project folder not resolved yet");
      if (layoutFileId) {
        await host.saveFileVersion(layoutFileId, text, "application/json");
        return layoutFileId;
      }
      const created = await host.createFile(project.dir, SIDECAR_NAME, text, "application/json", project.space);
      return created.id;
    },
    [project, host],
  );

  useEffect(() => {
    let alive = true;
    setGraph(null);
    setError(null);
    (async () => {
      const text = await host.readFileText(fileId);

      // Resolve the containing folder + space so we can list sibling files. For a
      // FileItem, `path` is already the containing directory (not the full file path),
      // both from a listing and from getFile — so use it as-is. Fall back to a metadata
      // lookup only when the host didn't hand us a path (e.g. a `?file=` deep link).
      const space = spaceId;
      let dir = filePath ?? "";
      if (filePath == null) {
        const meta = await host.getFile(fileId);
        if (meta) dir = meta.path ?? "";
      }

      let siblings = await host.listFiles(dir, space).catch(() => []);
      // Safety net: if the opened file isn't in the listed folder, our directory was
      // wrong — re-resolve it from metadata and relist. Keeps discovery working even if
      // a connector reports paths differently than expected.
      if (!siblings.some((f) => f.name === fileName)) {
        const meta = await host.getFile(fileId);
        const metaDir = meta?.path ?? "";
        if (metaDir !== dir) {
          dir = metaDir;
          siblings = await host.listFiles(dir, space).catch(() => []);
        }
      }
      const refs: SpecFileRef[] = siblings
        .filter((f) => f.kind !== "folder")
        .map((f) => ({ id: f.id, name: f.name, path: f.path ?? "" }));

      const files = await discoverProject({ id: fileId, name: fileName, path: filePath, text }, { siblings: refs, readText: (r) => host.readFileText(r.id) });
      const built = await buildProjectGraph(files);
      if (alive) {
        // Key layout by the project folder so positions are stable across reloads and
        // shared by every file opened in the same folder.
        setProjectKey(`${space ?? "personal"}|${dir}`);
        setProject({ dir, space });
        setGraph(built);
      }
    })().catch((e) => alive && setError(e instanceof Error ? e.message : "Failed to load"));

    return () => {
      alive = false;
    };
  }, [fileId, fileName, spaceId, filePath, nonce, host]);

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
  return <SpecEditorView graph={graph} fileName={fileName} projectKey={projectKey} onCommitLayout={commitLayout} onReload={reload} reloading={false} />;
}
