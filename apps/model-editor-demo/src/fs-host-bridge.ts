import type { AiModel, HostBridge, PluginFile } from "@canopy/plugin-sdk";

/**
 * A {@link HostBridge} backed by the browser's File System Access API. The user
 * grants access to a real local folder once; from then on the Model Editor reads
 * and writes the files on disk through this bridge, exactly as it would against the
 * Canopy drive or the VS Code host.
 *
 * File ids are POSIX-style paths relative to the granted root folder (e.g.
 * `schema.prisma` or `api/petstore.tsp`); the empty string is the root itself.
 * Everything the Model Editor never touches (spaces, connectors, plugin settings,
 * AI) is stubbed so the contract stays satisfied.
 */
export function createFsHostBridge(
  getRoot: () => FileSystemDirectoryHandle | null,
  openFile: (file: PluginFile) => void,
): HostBridge {
  const root = (): FileSystemDirectoryHandle => {
    const handle = getRoot();
    if (!handle) throw new Error("No folder opened yet");
    return handle;
  };

  const unsupported = (name: string): never => {
    throw new Error(`${name} is not available in the local filesystem demo`);
  };

  return {
    online: true,
    readFileText: async (id) => {
      const file = await (await fileHandle(root(), id)).getFile();
      return file.text();
    },
    saveFileVersion: async (id, text) => {
      const handle = await fileHandle(root(), id);
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
    },
    getFile: async (id) => {
      const { dir, name } = splitPath(id);
      return { id, name, path: dir, kind: name.includes(".") ? undefined : "folder" };
    },
    listFiles: async (dir) => {
      const base = dir ?? "";
      const handle = await dirHandle(root(), base);
      const out: PluginFile[] = [];
      for await (const [name, entry] of handle.entries()) {
        if (name.startsWith(".")) continue;
        out.push({
          id: base ? `${base}/${name}` : name,
          name,
          path: base,
          kind: entry.kind === "directory" ? "folder" : undefined,
        });
      }
      return out;
    },
    createFile: async (dir, name, content) => {
      const base = dir ?? "";
      const handle = await dirHandle(root(), base);
      const fh = await handle.getFileHandle(name, { create: true });
      const writable = await fh.createWritable();
      await writable.write(content);
      await writable.close();
      return { id: base ? `${base}/${name}` : name, name, path: base };
    },
    createAndOpenFile: async ({ name, content }) => {
      const fh = await root().getFileHandle(name, { create: true });
      const writable = await fh.createWritable();
      await writable.write(content);
      await writable.close();
      const file: PluginFile = { id: name, name, path: "" };
      openFile(file);
      return file;
    },

    // No AI provider in the static demo — the assistant simply offers no models.
    aiGenerate: async () => unsupported("aiGenerate"),
    listAiModels: async (): Promise<AiModel[]> => [],

    // Not applicable in the editor-only filesystem demo:
    getPluginSettings: async () => null,
    savePluginSettings: async () => {},
    getPluginPlaces: async () => [],
    applySpacePlugin: async () => unsupported("applySpacePlugin"),
    removeSpacePlugin: async () => unsupported("removeSpacePlugin"),
    listSpaces: async () => [],
    syncConnector: async () => ({ ok: false, error: "Connectors are not available in the demo" }),
    testConnector: async () => ({ ok: false, error: "Connectors are not available in the demo" }),
    listMount: async () => [],
    readMountText: async () => unsupported("readMountText"),
    mountFileUrl: () => "",
  };
}

/** Split a relative file id into its containing directory and base name. */
function splitPath(id: string): { dir: string; name: string } {
  const i = id.lastIndexOf("/");
  return i === -1 ? { dir: "", name: id } : { dir: id.slice(0, i), name: id.slice(i + 1) };
}

/** Walk from the root to the directory handle at a relative path (empty = root). */
async function dirHandle(root: FileSystemDirectoryHandle, dir: string): Promise<FileSystemDirectoryHandle> {
  let handle = root;
  for (const segment of dir.split("/").filter(Boolean)) {
    handle = await handle.getDirectoryHandle(segment);
  }
  return handle;
}

/** Resolve the file handle for a relative file id. */
async function fileHandle(root: FileSystemDirectoryHandle, id: string): Promise<FileSystemFileHandle> {
  const { dir, name } = splitPath(id);
  return (await dirHandle(root, dir)).getFileHandle(name);
}
