import type { Page, StorageConnector, StorageEntry } from "@canopy/core";

function joinPath(prefix: string, p: string | undefined): string {
  const a = prefix.replace(/\/+$/, "");
  const b = (p ?? "").replace(/^\/+/, "");
  return b ? `${a}/${b}` : a;
}

function stripPrefix(prefix: string, full: string): string {
  const pfx = `${prefix.replace(/\/+$/, "")}/`;
  return full.startsWith(pfx) ? full.slice(pfx.length) : full;
}

function reroot(prefix: string, e: StorageEntry): StorageEntry {
  return { ...e, path: stripPrefix(prefix, e.path) };
}

/**
 * Wraps a connector so every path is confined to `prefix` and presented relative
 * to it. The caller sees a clean root ("Documents"); on disk/R2 it's
 * "<prefix>/Documents". Used to give each signed-in user their own folder.
 */
export function scopedConnector(base: StorageConnector, prefix: string): StorageConnector {
  const conn: StorageConnector = {
    id: `${base.id}:${prefix}`,
    async list(p, opts): Promise<Page<StorageEntry>> {
      const page = await base.list(joinPath(prefix, p), opts);
      return { ...page, items: page.items.map((e) => reroot(prefix, e)) };
    },
    async stat(p) {
      const e = await base.stat(joinPath(prefix, p));
      return e ? reroot(prefix, e) : null;
    },
    read: (p) => base.read(joinPath(prefix, p)),
    async write(p, body) {
      return reroot(prefix, await base.write(joinPath(prefix, p), body));
    },
    remove: (p) => base.remove(joinPath(prefix, p)),
  };
  if (base.signedUrl) {
    conn.signedUrl = (p, op, exp) => base.signedUrl!(joinPath(prefix, p), op, exp);
  }
  return conn;
}

/** Per-user drive prefix from the OIDC subject; a shared `demo` folder for anonymous. */
export function driveScope(sub: string | null | undefined): string {
  if (!sub) return "demo";
  const safe = sub.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  return `users/${safe || "anon"}`;
}
