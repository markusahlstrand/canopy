import { describe, expect, it, beforeEach } from "vitest";
import { createLibsqlDb } from "./db-libsql";
import { createSqlBlobRepo } from "./repo";
import { runMigrations } from "./schema";
import { FileService } from "./files";
import { ensurePersonalSpace } from "./spaces";
import type { BlobStore } from "./blob-store";
import type { Db } from "./db";

/**
 * The path-based write methods that back WebDAV (PUT/DELETE/MOVE/COPY), against
 * the real SQL repo + in-memory libsql so json_set / json_extract run for real.
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

const USER = "user-1";
const caller = { sub: USER };
const enc = (s: string) => new TextEncoder().encode(s);
const text = async (svc: FileService, spaceId: string, path: string) => {
  const f = await svc.getByPath(USER, spaceId, path);
  if (!f?.version?.blobKey) return null;
  const body = await (svc as unknown as { store: BlobStore }).store.get(f.version.blobKey);
  return body ? await new Response(body).text() : null;
};

let db: Db;
let store: ReturnType<typeof memStore>;
let svc: FileService;
let space: string;

beforeEach(async () => {
  db = createLibsqlDb(":memory:");
  await runMigrations(db);
  store = memStore();
  svc = new FileService(db, store.store, createSqlBlobRepo(db));
  space = await ensurePersonalSpace(db, USER);
});

describe("putByPath", () => {
  it("creates a file at a nested path, then versions it on re-PUT", async () => {
    const a = await svc.putByPath(space, USER, "Docs/notes.txt", enc("v1"), "text/plain");
    expect(a.created).toBe(true);
    expect((await svc.list(USER, space, "Docs")).files.map((f) => f.name)).toEqual(["notes.txt"]);

    const b = await svc.putByPath(space, USER, "Docs/notes.txt", enc("v2"), "text/plain");
    expect(b.created).toBe(false);
    const file = await svc.getByPath(USER, space, "Docs/notes.txt");
    const versions = await svc.listVersions(caller, file!.id);
    expect(versions.length).toBe(1); // coalesced within the window
    expect(await text(svc, space, "Docs/notes.txt")).toBe("v2");
  });
});

describe("pathKind", () => {
  it("distinguishes files, folders, and nothing", async () => {
    await svc.putByPath(space, USER, "Docs/notes.txt", enc("x"));
    expect(await svc.pathKind(USER, space, "Docs/notes.txt")).toBe("file");
    expect(await svc.pathKind(USER, space, "Docs")).toBe("folder");
    expect(await svc.pathKind(USER, space, "Nope")).toBe(null);
  });
});

describe("moveByPath", () => {
  it("renames a file within a folder", async () => {
    await svc.putByPath(space, USER, "Docs/a.txt", enc("hi"));
    await svc.moveByPath(caller, space, "Docs/a.txt", "Docs/b.txt");
    expect(await svc.getByPath(USER, space, "Docs/a.txt")).toBe(null);
    expect(await text(svc, space, "Docs/b.txt")).toBe("hi");
  });

  it("moves a file to a different folder", async () => {
    await svc.putByPath(space, USER, "a.txt", enc("hi"));
    await svc.moveByPath(caller, space, "a.txt", "Archive/a.txt");
    expect(await text(svc, space, "Archive/a.txt")).toBe("hi");
  });

  it("renames a folder and reparents its descendants", async () => {
    await svc.putByPath(space, USER, "Old/one.txt", enc("1"));
    await svc.putByPath(space, USER, "Old/sub/two.txt", enc("2"));
    await svc.moveByPath(caller, space, "Old", "New");
    expect(await text(svc, space, "New/one.txt")).toBe("1");
    expect(await text(svc, space, "New/sub/two.txt")).toBe("2");
    expect(await svc.getByPath(USER, space, "Old/one.txt")).toBe(null);
  });
});

describe("copyByPath", () => {
  it("copies a file sharing the underlying blob (one byte set)", async () => {
    await svc.putByPath(space, USER, "a.txt", enc("dup"));
    await svc.copyByPath(caller, space, "a.txt", "b.txt");
    expect(await text(svc, space, "a.txt")).toBe("dup");
    expect(await text(svc, space, "b.txt")).toBe("dup");
    expect(store.map.size).toBe(1); // content-addressed: same bytes, one blob
  });
});

describe("deleteByPath", () => {
  it("trashes a single file", async () => {
    await svc.putByPath(space, USER, "a.txt", enc("bye"));
    await svc.deleteByPath(caller, space, "a.txt");
    expect(await svc.getByPath(USER, space, "a.txt")).toBe(null);
    expect((await svc.listTrash(USER)).map((f) => f.name)).toContain("a.txt");
  });

  it("trashes a whole folder subtree", async () => {
    await svc.putByPath(space, USER, "Box/one.txt", enc("1"));
    await svc.putByPath(space, USER, "Box/sub/two.txt", enc("2"));
    await svc.deleteByPath(caller, space, "Box");
    expect((await svc.list(USER, space, "")).folders).not.toContain("Box");
    expect(await svc.getByPath(USER, space, "Box/sub/two.txt")).toBe(null);
  });
});
