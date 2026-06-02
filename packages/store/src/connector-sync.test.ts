import { describe, expect, it, beforeEach } from "vitest";
import { createLibsqlDb } from "./db-libsql";
import { createSqlBlobRepo } from "./repo";
import { runMigrations } from "./schema";
import { FileService, type ConnectorChange, type ConnectorEntry, type ReconcileConnector } from "./files";
import { createSqlSearchIndex } from "./search";
import { syncConnection } from "./connector-sync";
import { ensurePersonalSpace } from "./spaces";
import { upsertUser } from "./users";
import type { Connection } from "./types";
import type { BlobStore } from "./blob-store";
import type { Db } from "./db";

/**
 * Integration: a connected space persisted + kept fresh from a connector. A fake
 * NAS backs both the reconcile listing and the byte reads (so the extract queue
 * can pull text). Proves the index converges on the backend — upsert / change /
 * rename-preserves-id / tombstone / @eaDir exclusion — and that drained text makes
 * a file findable by its content, surviving a later rename.
 */

function memStore() {
  const map = new Map<string, Uint8Array>();
  const store: BlobStore = {
    async has(k) {
      return map.has(k);
    },
    async put(k, b) {
      map.set(k, b);
    },
    async get(k) {
      const b = map.get(k);
      return b ? new Response(b as unknown as BodyInit).body : null;
    },
    async delete(k) {
      map.delete(k);
    },
  };
  return { store, map };
}

/** A tiny in-memory NAS: a flat path→file map that lists direct children and reads bytes. */
class FakeNas {
  files = new Map<string, { content: string; mtime: number; ctime: number; mime?: string }>();

  set(path: string, content: string, opts: { mtime?: number; ctime?: number; mime?: string } = {}): void {
    this.files.set(path, { content, mtime: opts.mtime ?? 1000, ctime: opts.ctime ?? 500, mime: opts.mime });
  }

  list(dir: string): Promise<{ items: ConnectorEntry[] }> {
    const prefix = dir ? `${dir}/` : "";
    const items: ConnectorEntry[] = [];
    const folders = new Set<string>();
    for (const [path, f] of this.files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf("/");
      if (slash === -1) {
        const size = f.content.length;
        items.push({
          path,
          name: rest,
          kind: "file",
          size,
          modifiedAt: new Date(f.mtime * 1000).toISOString(),
          createdAt: new Date(f.ctime * 1000).toISOString(),
          etag: `${size}:${f.mtime}`,
          contentType: f.mime,
        });
      } else {
        const name = rest.slice(0, slash);
        if (!folders.has(name)) {
          folders.add(name);
          items.push({ path: `${prefix}${name}`, name, kind: "folder" });
        }
      }
    }
    return Promise.resolve({ items });
  }

  read(path: string): Promise<ReadableStream<Uint8Array> | null> {
    const f = this.files.get(path);
    return Promise.resolve(f ? new Response(new TextEncoder().encode(f.content)).body : null);
  }

  async *changes(cursor?: string): AsyncIterable<ConnectorChange> {
    const since = cursor ? Number(cursor) : 0;
    for (const [path, f] of this.files) {
      if (f.mtime < since) continue;
      const size = f.content.length;
      const name = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
      yield { type: "updated", path, entry: { path, name, kind: "file", size, modifiedAt: new Date(f.mtime * 1000).toISOString(), etag: `${size}:${f.mtime}` } };
    }
  }

  connector(withChanges = false): ReconcileConnector {
    return withChanges ? { list: (dir) => this.list(dir), changes: (c) => this.changes(c) } : { list: (dir) => this.list(dir) };
  }
}

const PLUGIN = "synology";
const USER = "user-1";
const OTHER = "user-2";

let db: Db;
let store: ReturnType<typeof memStore>;
let nas: FakeNas;
let svc: FileService;
let space: string;

beforeEach(async () => {
  db = createLibsqlDb(":memory:");
  await runMigrations(db);
  store = memStore();
  nas = new FakeNas();
  svc = new FileService(db, store.store, createSqlBlobRepo(db), {
    index: createSqlSearchIndex(db),
    // Treat .md/.txt as text; everything else non-extractable (skip).
    readExternal: async (version) => (version.externalKey ? nas.read(version.externalKey) : null),
  });
  await upsertUser(db, { sub: USER, email: "u1@example.com" });
  await upsertUser(db, { sub: OTHER, email: "u2@example.com" });
  space = await svc.ensureConnectorSpace(USER, PLUGIN, "My NAS");
});

const reconcile = (dir = "") => svc.reconcileConnectorFolder(USER, space, PLUGIN, nas.connector(), dir);
const ids = (r: { items: { id: string }[] }) => r.items.map((i) => i.id);
const listNames = async (dir = "") => {
  const r = await svc.list(USER, space, dir);
  return { files: r.files.map((f) => f.name).sort(), folders: [...r.folders].sort() };
};

describe("connected-space reconcile", () => {
  it("inserts new files + subfolders and lists them from the index", async () => {
    nas.set("notes.md", "hello");
    nas.set("photos/sunset.jpg", "bytes", { mime: "image/jpeg" });
    const { upserted } = await reconcile("");
    expect(upserted).toBe(1); // one file at root; the folder is not a file
    expect(await listNames("")).toEqual({ files: ["notes.md"], folders: ["photos"] });
    // Findable by name immediately (before any text extraction).
    expect(ids(await svc.search(USER, { text: "notes" }))).toHaveLength(1);
  });

  it("excludes @eaDir and #recycle", async () => {
    nas.set("doc.md", "x");
    nas.set("@eaDir/thumb.jpg", "x");
    nas.set("#recycle/old.md", "x");
    await reconcile("");
    expect(await listNames("")).toEqual({ files: ["doc.md"], folders: [] });
  });

  it("is idempotent: a second reconcile with no changes upserts nothing", async () => {
    nas.set("a.md", "x");
    await reconcile("");
    const { upserted, tombstoned } = await reconcile("");
    expect(upserted).toBe(0);
    expect(tombstoned).toBe(0);
  });

  it("updates a changed file (new etag) and re-enqueues extraction", async () => {
    nas.set("a.md", "one", { mtime: 1000 });
    await reconcile("");
    await svc.drainExternalExtractQueue();
    expect(ids(await svc.search(USER, { text: "one" }))).toHaveLength(1);

    nas.set("a.md", "two different words", { mtime: 2000 }); // mtime bump → new etag
    const { upserted } = await reconcile("");
    expect(upserted).toBe(1);
    await svc.drainExternalExtractQueue();
    expect(ids(await svc.search(USER, { text: "two" }))).toHaveLength(1);
    expect(ids(await svc.search(USER, { text: "one" }))).toHaveLength(0);
  });

  it("tombstones a file that disappeared from the backend", async () => {
    nas.set("keep.md", "x");
    nas.set("gone.md", "x");
    await reconcile("");
    expect((await listNames("")).files).toEqual(["gone.md", "keep.md"]);

    nas.files.delete("gone.md");
    const { tombstoned } = await reconcile("");
    expect(tombstoned).toBe(1);
    expect((await listNames("")).files).toEqual(["keep.md"]);
    expect(ids(await svc.search(USER, { text: "gone" }))).toHaveLength(0);
  });

  it("treats a same-content rename as a move: keeps the id, no re-extract", async () => {
    nas.set("old-name.md", "the mitochondria is the powerhouse", { mtime: 1000 });
    await reconcile("");
    await svc.drainExternalExtractQueue();
    const before = await svc.list(USER, space, "");
    const originalId = before.files[0]!.id;
    expect(ids(await svc.search(USER, { text: "powerhouse" }))).toEqual([originalId]);

    // Rename on the NAS: same bytes + mtime (so same synthetic etag), new path.
    const f = nas.files.get("old-name.md")!;
    nas.files.delete("old-name.md");
    nas.files.set("new-name.md", f);

    const { upserted, tombstoned } = await reconcile("");
    expect(tombstoned).toBe(0); // matched as a rename, not delete+add
    expect(upserted).toBe(1);
    const after = await svc.list(USER, space, "");
    expect(after.files).toHaveLength(1);
    expect(after.files[0]!.id).toBe(originalId); // id preserved
    expect(after.files[0]!.name).toBe("new-name.md");
    // Body survived the rename WITHOUT draining again (extract state stayed 'done').
    expect(ids(await svc.search(USER, { text: "powerhouse" }))).toEqual([originalId]);
    expect(ids(await svc.search(USER, { text: "new" }))).toEqual([originalId]); // findable by new name
  });

  it("prunes a whole subfolder that disappeared", async () => {
    nas.set("docs/a.md", "x");
    nas.set("docs/b.md", "x");
    nas.set("root.md", "x");
    await reconcile("");
    await reconcile("docs");
    expect((await listNames("docs")).files).toEqual(["a.md", "b.md"]);

    nas.files.delete("docs/a.md");
    nas.files.delete("docs/b.md");
    const { tombstoned } = await reconcile(""); // reconcile the PARENT — subfolder gone
    expect(tombstoned).toBe(2);
    expect((await listNames("")).folders).toEqual([]);
  });
});

describe("external extract queue", () => {
  it("makes a file findable by its body text after draining, and caches it in R2", async () => {
    nas.set("report.md", "Quarterly revenue powerhouse summary");
    await reconcile("");
    expect(ids(await svc.search(USER, { text: "powerhouse" }))).toHaveLength(0); // not yet extracted

    const { extracted } = await svc.drainExternalExtractQueue();
    expect(extracted).toBe(1);
    expect(ids(await svc.search(USER, { text: "powerhouse" }))).toHaveLength(1);
    // Extracted text cached as a blob (content_ref) so reindex never re-reads the NAS.
    expect([...store.map.keys()].some((k) => k.startsWith("extract/"))).toBe(true);

    // Second drain is a no-op (nothing pending).
    expect((await svc.drainExternalExtractQueue()).extracted).toBe(0);
  });

  it("leaves a non-text file findable by name only (skipped, never read)", async () => {
    let reads = 0;
    const svc2 = new FileService(db, store.store, createSqlBlobRepo(db), {
      index: createSqlSearchIndex(db),
      readExternal: async (version) => {
        reads++;
        return version.externalKey ? nas.read(version.externalKey) : null;
      },
    });
    nas.set("holiday.png", "binary", { mime: "image/png" });
    await svc2.reconcileConnectorFolder(USER, space, PLUGIN, nas.connector(), "");
    await svc2.drainExternalExtractQueue();
    expect(reads).toBe(0); // skip-state: never fetched
    expect(ids(await svc2.search(USER, { text: "holiday" }))).toHaveLength(1); // name still indexed
  });
});

describe("connected-space isolation", () => {
  it("does not leak one user's connector files to another", async () => {
    nas.set("secret.md", "the powerhouse of the cell");
    await reconcile("");
    await svc.drainExternalExtractQueue();
    await ensurePersonalSpace(db, OTHER);
    expect(await svc.search(OTHER, { text: "powerhouse" })).toEqual({ items: [] });
  });
});

describe("sweep (syncConnection)", () => {
  const conn = (): Connection => ({ id: space, tenantId: space, ownerId: USER, type: PLUGIN, name: "My NAS", config: {}, createdAt: "2026-01-01T00:00:00Z" });
  const deps = (withChanges: boolean) => ({ db, service: svc, connectorForUser: async () => nas.connector(withChanges) });

  it("crawls the whole tree on the first run (no change feed)", async () => {
    nas.set("a.md", "x");
    nas.set("deep/b.md", "y");
    nas.set("deep/nested/c.md", "z");
    await syncConnection(deps(false), conn());
    expect((await listNames("")).files).toEqual(["a.md"]);
    expect((await listNames("deep")).files).toEqual(["b.md"]);
    expect((await listNames("deep/nested")).files).toEqual(["c.md"]); // recursed to the leaf
  });

  it("uses the change feed to reconcile only the touched folders", async () => {
    nas.set("a.md", "old", { mtime: 1000 });
    nas.set("deep/old.md", "old", { mtime: 1000 });
    nas.set("new.md", "fresh", { mtime: 2000 }); // changed since the cursor below
    // Seed a prior successful run so syncConnection takes the incremental path.
    await db.run(
      "INSERT INTO index_runs (id, connection_id, status, cursor, files_seen, started_at, finished_at) VALUES ('r0', ?, 'done', '1500', 0, ?, ?)",
      [space, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
    );
    await syncConnection(deps(true), conn());
    // Root was reconciled (it held a changed file) → both root files indexed...
    expect((await listNames("")).files).toEqual(["a.md", "new.md"]);
    // ...but `deep/` was NOT touched by the feed, so it stays unreconciled (unlike a crawl).
    expect((await listNames("deep")).files).toEqual([]);
  });

  it("advances the run cursor so the next sweep resumes from it", async () => {
    nas.set("a.md", "x");
    await syncConnection(deps(true), conn());
    const run = await db.first<{ cursor: string | null; status: string }>(
      "SELECT cursor, status FROM index_runs WHERE connection_id = ? ORDER BY finished_at DESC LIMIT 1",
      [space],
    );
    expect(run?.status).toBe("done");
    expect(Number(run?.cursor)).toBeGreaterThan(0);
  });
});
