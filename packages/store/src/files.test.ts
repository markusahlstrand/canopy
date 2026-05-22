import { describe, expect, it, beforeEach } from "vitest";
import { createLibsqlDb } from "./db-libsql";
import { createSqlBlobRepo } from "./repo";
import { runMigrations } from "./schema";
import { FileService, PermissionError } from "./files";
import { ensurePersonalSpace } from "./spaces";
import { upsertUser } from "./users";
import { sha256hex } from "./hash";
import type { BlobStore } from "./blob-store";
import type { Db } from "./db";

/**
 * Integration: the real SQL repo + FileService against an in-memory libsql
 * (SQLite) engine — so RETURNING, ON CONFLICT, and json_extract are exercised
 * for real — plus an in-memory blob store. Covers the spec's integration cases.
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
const enc = (s: string) => new TextEncoder().encode(s);

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

/** Full client flow: hash → prepare → (upload if miss) → create file. */
async function upload(name: string, content: string, opts: { path?: string; metadata?: Record<string, unknown> } = {}) {
  const bytes = enc(content);
  const hash = await sha256hex(bytes);
  const prep = await svc.prepareUpload(space, USER, hash);
  if (!prep.exists) await svc.commitUpload(space, USER, hash, bytes);
  return svc.createFile(space, USER, { name, hash, mime: "text/plain", path: opts.path, metadata: opts.metadata });
}

describe("FileService over libsql", () => {
  it("upload → dedup-hit → download roundtrip; identical content stored once", async () => {
    const a = await upload("a.txt", "same bytes");
    const b = await upload("b.txt", "same bytes"); // dedup hit

    expect(a.version!.blobKey).toBe(b.version!.blobKey);
    const blob = await db.first<{ ref_count: number }>("SELECT ref_count FROM blobs WHERE hash = ?", [a.version!.blobKey]);
    expect(blob?.ref_count).toBe(2);
    const blobRows = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM blobs");
    expect(blobRows[0]!.n).toBe(1);

    const { key } = await svc.getContentKey({ sub: USER }, a.id);
    const stream = await store.store.get(key);
    expect(await new Response(stream).text()).toBe("same bytes");
  });

  it("metadata edit does NOT create a new version", async () => {
    const f = await upload("doc.md", "# hi", { metadata: { tag: "x" } });
    const before = f.currentVersionId;

    const patched = await svc.patchMetadata({ sub: USER }, f.id, { tag: "y", starred: true });
    expect(patched.currentVersionId).toBe(before);
    expect(patched.metadata.tag).toBe("y");
    expect(patched.metadata.starred).toBe(true);

    const versions = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM file_versions WHERE file_id = ?", [f.id]);
    expect(versions[0]!.n).toBe(1);
  });

  it("content replacement does NOT alter metadata", async () => {
    const f = await upload("notes.md", "v1", { path: "Docs", metadata: { tag: "keep" } });

    const bytes = enc("v2 contents");
    const hash = await sha256hex(bytes);
    await svc.prepareUpload(space, USER, hash);
    await svc.commitUpload(space, USER, hash, bytes);
    const updated = await svc.addVersion({ sub: USER }, f.id, { hash, mime: "text/plain" });

    expect(updated.currentVersionId).not.toBe(f.currentVersionId);
    expect(updated.metadata.tag).toBe("keep");
    expect(updated.metadata.path).toBe("Docs");
    const versions = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM file_versions WHERE file_id = ?", [f.id]);
    expect(versions[0]!.n).toBe(2);
  });

  it("delete releases a ref; the blob is removed only at ref_count 0", async () => {
    const a = await upload("a.txt", "shared");
    const b = await upload("b.txt", "shared");
    const key = a.version!.blobKey!;

    await svc.deleteFile({ sub: USER }, a.id); // ref 2 → 1, blob kept
    expect(store.map.has(key)).toBe(true);
    expect((await db.first<{ ref_count: number }>("SELECT ref_count FROM blobs WHERE hash = ?", [key]))?.ref_count).toBe(1);

    await svc.deleteFile({ sub: USER }, b.id); // ref 1 → 0, blob gone
    expect(store.map.has(key)).toBe(false);
    expect(await db.first("SELECT 1 FROM blobs WHERE hash = ?", [key])).toBeNull();
  });

  it("lists a virtual folder: files at the path plus child folders", async () => {
    await upload("root.txt", "r");
    await upload("lease.pdf", "l", { path: "Documents" });
    await upload("photo.jpg", "p", { path: "Documents/2026" });

    const root = await svc.list(USER, space, "");
    expect(root.files.map((f) => f.name)).toEqual(["root.txt"]);
    expect(root.folders).toEqual(["Documents"]);

    const docs = await svc.list(USER, space, "Documents");
    expect(docs.files.map((f) => f.name)).toEqual(["lease.pdf"]);
    expect(docs.folders).toEqual(["2026"]);
  });

  it("enforces resource permissions (a stranger can't read)", async () => {
    const f = await upload("secret.txt", "shh");
    await expect(svc.getFile({ sub: "intruder" }, f.id)).rejects.toBeInstanceOf(PermissionError);
  });

  it("a file shared with another user becomes visible to them", async () => {
    const f = await upload("shared-note.md", "hello", { path: "" });
    // grant bob viewer directly on the file
    await svc.shareGrant({ sub: USER }, f.id, { subjectType: "user", subjectId: "bob", role: "viewer" });
    expect((await svc.getFile({ sub: "bob" }, f.id)).name).toBe("shared-note.md");
    const shared = await svc.listSharedWithMe("bob");
    expect(shared.map((x) => x.name)).toEqual(["shared-note.md"]);
    // bob can read but not delete
    await expect(svc.deleteFile({ sub: "bob" }, f.id)).rejects.toBeInstanceOf(PermissionError);
  });

  it("creates an empty folder that persists in listings, and overview counts files", async () => {
    await svc.createFolder(space, USER, "Photos");
    const root = await svc.list(USER, space, "");
    expect(root.folders).toContain("Photos");

    await upload("a.txt", "aaa");
    await upload("b.txt", "bbbbb");
    const ov = await svc.overview(USER, space);
    expect(ov.files).toBe(2);
    expect(ov.bytes).toBe(8); // 3 + 5
  });

  it("list enriches files with shared-with labels, an owner label, and the space name", async () => {
    await upsertUser(db, { sub: USER, email: "me@x.com", name: "Me" });
    const f = await upload("doc.md", "hi");
    await svc.shareGrant({ sub: USER }, f.id, { subjectType: "email", subjectId: "friend@x.com", role: "viewer" });

    const root = await svc.list(USER, space, "");
    expect(root.spaceName).toBe("My Drive");
    const item = root.files.find((x) => x.name === "doc.md")!;
    expect(item.ownerLabel).toBe("Me");
    expect(item.sharedWith).toContain("friend@x.com");
    expect(item.sharedWith).not.toContain("Me"); // owner's own grant is excluded
  });

  it("getByPath resolves a file by its virtual path (for WebDAV)", async () => {
    await upload("lease.pdf", "x", { path: "Documents" });
    expect((await svc.getByPath(USER, space, "Documents/lease.pdf"))?.name).toBe("lease.pdf");
    expect(await svc.getByPath(USER, space, "Documents/missing.pdf")).toBeNull();
  });

  it("app passwords: create → verify → delete", async () => {
    const { id, token } = await svc.createAppPassword(USER, "Mac");
    expect(await svc.verifyAppPassword(token)).toBe(USER);
    expect(await svc.verifyAppPassword("nope")).toBeNull();
    expect((await svc.listAppPasswords(USER)).find((p) => p.id === id)?.name).toBe("Mac");
    await svc.deleteAppPassword(USER, id);
    expect(await svc.verifyAppPassword(token)).toBeNull();
  });

  it("soft-deleted files disappear from listings", async () => {
    const f = await upload("temp.txt", "bye");
    await svc.deleteFile({ sub: USER }, f.id);
    const root = await svc.list(USER, space, "");
    expect(root.files).toHaveLength(0);
  });

  it("plugin settings: round-trip, upsert, and per-user isolation", async () => {
    expect(await svc.getPluginSettings(USER, "github")).toBeNull();

    await svc.setPluginSettings(USER, "github", JSON.stringify({ repo: "a/b" }));
    expect(JSON.parse((await svc.getPluginSettings(USER, "github"))!)).toEqual({ repo: "a/b" });

    // upsert replaces
    await svc.setPluginSettings(USER, "github", JSON.stringify({ repo: "c/d", token: "enc" }));
    expect(JSON.parse((await svc.getPluginSettings(USER, "github"))!)).toEqual({ repo: "c/d", token: "enc" });

    // another user has their own
    expect(await svc.getPluginSettings("user-2", "github")).toBeNull();

    await svc.deletePluginSettings(USER, "github");
    expect(await svc.getPluginSettings(USER, "github")).toBeNull();
  });

  it("invite link: create → preview → accept grants membership; single-use", async () => {
    const fam = await svc.createSpace({ sub: USER }, "Family");
    const invite = await svc.createSpaceInvite({ sub: USER }, fam.id, "editor");

    // Preview works without a caller (the landing page shows it before sign-in).
    const info = await svc.inviteInfo(invite.token);
    expect(info).toMatchObject({ status: "valid", spaceName: "Family", role: "editor" });

    // Bob opens the link and accepts → becomes an editor member of the space.
    const res = await svc.acceptSpaceInvite({ sub: "bob" }, invite.token);
    expect(res).toEqual({ spaceId: fam.id, alreadyMember: false });
    const members = await svc.spaceMembers({ sub: USER }, fam.id);
    expect(members.find((m) => m.sub === "bob")?.role).toBe("editor");

    // Single-use: a second person can't reuse it, and it's no longer listed/valid.
    await expect(svc.acceptSpaceInvite({ sub: "carol" }, invite.token)).rejects.toThrow(/already been used/);
    expect(await svc.spaceInvites({ sub: USER }, fam.id)).toHaveLength(0);
    expect((await svc.inviteInfo(invite.token)).status).toBe("used");
  });

  it("invite link: only an owner can mint or revoke; revoke kills the link", async () => {
    const fam = await svc.createSpace({ sub: USER }, "Team");
    await expect(svc.createSpaceInvite({ sub: "stranger" }, fam.id, "viewer")).rejects.toBeInstanceOf(PermissionError);

    const invite = await svc.createSpaceInvite({ sub: USER }, fam.id, "viewer");
    await svc.revokeSpaceInvite({ sub: USER }, fam.id, invite.token);
    expect((await svc.inviteInfo(invite.token)).status).toBe("not_found");
    await expect(svc.acceptSpaceInvite({ sub: "bob" }, invite.token)).rejects.toThrow(/invite not found/);
  });
});
