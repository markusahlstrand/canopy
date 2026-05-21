import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep, posix } from "node:path";
import { Readable } from "node:stream";
import type {
  ConnectorConfigField,
  Page,
  StorageConnector,
  StorageConnectorPlugin,
  StorageEntry,
} from "@canopy/core";

/** Resolve a connector-relative POSIX path to an absolute path inside `root`, blocking traversal. */
function safeResolve(root: string, p: string): string {
  const clean = posix.normalize("/" + (p ?? "")).replace(/^\/+/, "");
  const abs = resolve(root, clean.split("/").join(sep));
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`Path escapes connector root: ${p}`);
  }
  return abs;
}

function toEntry(relPath: string, name: string, isDir: boolean, size: number, mtime: Date): StorageEntry {
  return {
    path: relPath,
    name,
    kind: isDir ? "folder" : "file",
    size: isDir ? undefined : size,
    modifiedAt: mtime.toISOString(),
  };
}

export function createLocalConnector(id: string, root: string): StorageConnector {
  const absRoot = resolve(root);

  return {
    id,

    async list(path, _opts): Promise<Page<StorageEntry>> {
      const dir = safeResolve(absRoot, path);
      let dirents;
      try {
        dirents = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        // A not-yet-created folder (e.g. a new user's drive) lists as empty.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return { items: [] };
        throw err;
      }
      const items: StorageEntry[] = [];
      for (const d of dirents) {
        if (d.name.startsWith(".")) continue;
        const childRel = posix.join(path || "", d.name).replace(/^\/+/, "");
        const st = await stat(join(dir, d.name));
        items.push(toEntry(childRel, d.name, d.isDirectory(), st.size, st.mtime));
      }
      // Folders first, then alphabetical.
      items.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return { items };
    },

    async stat(path): Promise<StorageEntry | null> {
      try {
        const abs = safeResolve(absRoot, path);
        const st = await stat(abs);
        const name = path.split("/").filter(Boolean).pop() ?? "";
        return toEntry(path.replace(/^\/+/, ""), name, st.isDirectory(), st.size, st.mtime);
      } catch {
        return null;
      }
    },

    async read(path): Promise<ReadableStream<Uint8Array>> {
      const abs = safeResolve(absRoot, path);
      return Readable.toWeb(createReadStream(abs)) as ReadableStream<Uint8Array>;
    },

    async write(path, body): Promise<StorageEntry> {
      const abs = safeResolve(absRoot, path);
      await mkdir(resolve(abs, ".."), { recursive: true });
      const data = body instanceof Uint8Array ? body : Buffer.from(await new Response(body).arrayBuffer());
      await writeFile(abs, data);
      const st = await stat(abs);
      const name = path.split("/").filter(Boolean).pop() ?? "";
      return toEntry(path.replace(/^\/+/, ""), name, false, st.size, st.mtime);
    },

    async remove(path): Promise<void> {
      const abs = safeResolve(absRoot, path);
      await rm(abs, { recursive: true, force: true });
    },
  };
}

const configFields: ConnectorConfigField[] = [
  { key: "root", label: "Root directory", type: "string", required: true },
];

export const localConnectorPlugin: StorageConnectorPlugin = {
  type: "local",
  label: "Local filesystem",
  configFields,
  create(id, config) {
    const root = String(config.root ?? "");
    if (!root) throw new Error("connector-local requires a 'root' directory");
    return createLocalConnector(id, root);
  },
};
