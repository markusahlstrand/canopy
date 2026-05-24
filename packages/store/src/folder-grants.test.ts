import { describe, expect, it, beforeEach } from "vitest";
import { createLibsqlDb } from "./db-libsql";
import { createSqlBlobRepo } from "./repo";
import { runMigrations } from "./schema";
import { FileService, PermissionError } from "./files";
import { ensurePersonalSpace, createSpace, addMember } from "./spaces";
import type { BlobStore } from "./blob-store";
import type { Db } from "./db";

/**
 * Folder grants — sharing a folder (and its whole subtree) with a user, an
 * email, or a place, as a first-class authz object. A grant covers the folder
 * and everything under it, and nothing above or beside it.
 */

function memStore(): BlobStore {
  const map = new Map<string, Uint8Array>();
  return {
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
}

const OWNER = "owner-1";
const BOB = "bob-1"; // not a member of OWNER's space
const CARL = "carl-1";
const owner = { sub: OWNER };
const bob = { sub: BOB };
const enc = (s: string) => new TextEncoder().encode(s);

let db: Db;
let svc: FileService;
let space: string;

beforeEach(async () => {
  db = createLibsqlDb(":memory:");
  await runMigrations(db);
  svc = new FileService(db, memStore(), createSqlBlobRepo(db));
  space = await ensurePersonalSpace(db, OWNER);
  await svc.putByPath(space, OWNER, "Photos/a.txt", enc("A"), "text/plain");
  await svc.putByPath(space, OWNER, "Photos/sub/b.txt", enc("B"), "text/plain");
  await svc.putByPath(space, OWNER, "Private/s.txt", enc("S"), "text/plain");
});

describe("folder grant — read", () => {
  it("grants subtree access (incl. nested) but not siblings or the root", async () => {
    await svc.shareFolderGrant(owner, space, "Photos", { subjectType: "user", subjectId: BOB, role: "viewer" });

    expect(await svc.getByPath(BOB, space, "Photos/a.txt")).not.toBe(null);
    expect(await svc.getByPath(BOB, space, "Photos/sub/b.txt")).not.toBe(null); // inherited down
    expect((await svc.list(BOB, space, "Photos")).files.map((f) => f.name)).toContain("a.txt");

    await expect(svc.getByPath(BOB, space, "Private/s.txt")).rejects.toBeInstanceOf(PermissionError);
    await expect(svc.list(BOB, space, "")).rejects.toBeInstanceOf(PermissionError); // can't see the parent

    // viewer can't write
    await expect(svc.putByPath(space, BOB, "Photos/x.txt", enc("x"))).rejects.toBeInstanceOf(PermissionError);
  });

  it("works for file-id access too (requirePerm folds in folder grants)", async () => {
    await svc.shareFolderGrant(owner, space, "Photos", { subjectType: "user", subjectId: BOB, role: "viewer" });
    const file = await svc.getByPath(OWNER, space, "Photos/a.txt");
    expect((await svc.getFile(bob, file!.id)).name).toBe("a.txt");
  });
});

describe("folder grant — write (editor)", () => {
  it("lets an editor write within the subtree only", async () => {
    await svc.shareFolderGrant(owner, space, "Photos", { subjectType: "user", subjectId: BOB, role: "editor" });

    await svc.putByPath(space, BOB, "Photos/new.txt", enc("hi"), "text/plain");
    expect(await svc.getByPath(BOB, space, "Photos/new.txt")).not.toBe(null);
    await svc.createFolder(space, BOB, "Photos/album");

    await expect(svc.putByPath(space, BOB, "Private/x.txt", enc("x"))).rejects.toBeInstanceOf(PermissionError);
  });
});

describe("folder grant — place subject", () => {
  it("grants access to members of a place the folder is shared with", async () => {
    const place = await createSpace(db, { name: "Place", createdBy: OWNER });
    await addMember(db, place.id, CARL, "viewer");
    await svc.shareFolderGrant(owner, space, "Photos", { subjectType: "space", subjectId: place.id, role: "viewer" });

    expect(await svc.getByPath(CARL, space, "Photos/a.txt")).not.toBe(null);
    await expect(svc.getByPath(CARL, space, "Private/s.txt")).rejects.toBeInstanceOf(PermissionError);
  });
});

describe("folder grant — revoke + move", () => {
  it("revoke removes access", async () => {
    await svc.shareFolderGrant(owner, space, "Photos", { subjectType: "user", subjectId: BOB, role: "viewer" });
    expect(await svc.getByPath(BOB, space, "Photos/a.txt")).not.toBe(null);

    await svc.unshareFolderGrant(owner, space, "Photos", { subjectType: "user", subjectId: BOB, role: "viewer" });
    await expect(svc.getByPath(BOB, space, "Photos/a.txt")).rejects.toBeInstanceOf(PermissionError);
  });

  it("the grant follows the folder when it's renamed/moved", async () => {
    await svc.shareFolderGrant(owner, space, "Photos", { subjectType: "user", subjectId: BOB, role: "viewer" });
    await svc.moveByPath(owner, space, "Photos", "Album");

    expect(await svc.getByPath(BOB, space, "Album/a.txt")).not.toBe(null);
    expect(await svc.getByPath(BOB, space, "Album/sub/b.txt")).not.toBe(null);
    expect((await svc.listSharedFolders(BOB)).map((f) => f.path)).toEqual(["Album"]);
  });

  it("deleting a folder drops its grants", async () => {
    await svc.shareFolderGrant(owner, space, "Photos", { subjectType: "user", subjectId: BOB, role: "viewer" });
    await svc.deleteByPath(owner, space, "Photos");
    expect(await svc.listSharedFolders(BOB)).toEqual([]);
  });
});

describe("listSharedFolders", () => {
  it("reports folders shared with the user, with role", async () => {
    await svc.shareFolderGrant(owner, space, "Photos", { subjectType: "user", subjectId: BOB, role: "editor" });
    expect(await svc.listSharedFolders(BOB)).toEqual([{ spaceId: space, path: "Photos", role: "editor" }]);
  });
});
