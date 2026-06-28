import { describe, expect, it, beforeEach } from "vitest";
import { createLibsqlDb } from "./db-libsql";
import { createSqlBlobRepo } from "./repo";
import { runMigrations } from "./schema";
import { FileService, PermissionError } from "./files";
import { addMember, ensurePersonalSpace } from "./spaces";
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

/**
 * Save new text as a content version of an existing file (upload → addVersion), as USER.
 * Pass `window` to use a service with a custom coalesce window (0 = always append).
 */
async function save(fileId: string, content: string, window?: number) {
  const bytes = enc(content);
  const hash = await sha256hex(bytes);
  const prep = await svc.prepareUpload(space, USER, hash);
  if (!prep.exists) await svc.commitUpload(space, USER, hash, bytes);
  const service =
    window != null ? new FileService(db, store.store, createSqlBlobRepo(db), { versionCoalesceWindowMs: window }) : svc;
  return service.addVersion({ sub: USER }, fileId, { hash, mime: "text/plain" });
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

  it("rename updates the name column without a new version or losing metadata", async () => {
    const f = await upload("old.md", "# hi", { metadata: { tag: "x" } });
    const before = f.currentVersionId;

    const renamed = await svc.patchMetadata({ sub: USER }, f.id, { name: "new.md" });
    expect(renamed.name).toBe("new.md");
    expect(renamed.metadata.tag).toBe("x"); // metadata survives
    expect(renamed.metadata.name).toBeUndefined(); // name lands on the column, not the blob
    expect(renamed.currentVersionId).toBe(before);

    const versions = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM file_versions WHERE file_id = ?", [f.id]);
    expect(versions[0]!.n).toBe(1);
  });

  it("rejects an empty name or one with a path separator", async () => {
    const f = await upload("doc.md", "# hi");
    await expect(svc.patchMetadata({ sub: USER }, f.id, { name: "  " })).rejects.toThrow();
    await expect(svc.patchMetadata({ sub: USER }, f.id, { name: "a/b.md" })).rejects.toThrow();
    const still = await svc.getFile({ sub: USER }, f.id);
    expect(still.name).toBe("doc.md");
  });

  it("rapid same-author edits coalesce into one version, keep metadata, and release the old blob", async () => {
    const f = await upload("notes.md", "v1", { path: "Docs", metadata: { tag: "keep" } });
    const v1Key = f.version!.blobKey!;

    const updated = await save(f.id, "v2 contents"); // within the default window → coalesces

    // Same version row, replaced content; metadata untouched.
    expect(updated.currentVersionId).toBe(f.currentVersionId);
    expect(updated.metadata.tag).toBe("keep");
    expect(updated.metadata.path).toBe("Docs");
    expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM file_versions WHERE file_id = ?", [f.id]))?.n).toBe(1);

    // The superseded blob is released (gone — nothing else references it); the new one holds one ref.
    expect(store.map.has(v1Key)).toBe(false);
    expect(await db.first("SELECT 1 FROM blobs WHERE hash = ?", [v1Key])).toBeNull();
    const newKey = updated.version!.blobKey!;
    expect((await db.first<{ ref_count: number }>("SELECT ref_count FROM blobs WHERE hash = ?", [newKey]))?.ref_count).toBe(1);
    expect(await new Response(await store.store.get(newKey)).text()).toBe("v2 contents");
  });

  it("an explicit save (coalesce:false) appends a new version even within the window", async () => {
    const f = await upload("notes.md", "draft one");
    const v1 = f.currentVersionId!;
    // Same author, well within the default 10-min window — but an explicit Save must
    // never merge into the current version's editing session.
    const bytes = enc("draft two");
    const hash = await sha256hex(bytes);
    const prep = await svc.prepareUpload(space, USER, hash);
    if (!prep.exists) await svc.commitUpload(space, USER, hash, bytes);
    const updated = await svc.addVersion({ sub: USER }, f.id, { hash, mime: "text/plain", coalesce: false });

    expect(updated.currentVersionId).not.toBe(v1); // a brand-new version row
    expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM file_versions WHERE file_id = ?", [f.id]))?.n).toBe(2);
    expect(await new Response(await store.store.get(updated.version!.blobKey!)).text()).toBe("draft two");
  });

  it("re-saving identical content coalesces without leaking a blob ref", async () => {
    const f = await upload("doc.md", "same bytes");
    const key = f.version!.blobKey!;
    await save(f.id, "same bytes"); // identical → dedup hit + coalesce

    expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM file_versions WHERE file_id = ?", [f.id]))?.n).toBe(1);
    expect((await db.first<{ ref_count: number }>("SELECT ref_count FROM blobs WHERE hash = ?", [key]))?.ref_count).toBe(1);
  });

  it("a save past the coalesce window appends a new version; history lists newest-first with author labels", async () => {
    await upsertUser(db, { sub: USER, email: "me@x.com", name: "Me" });
    const f = await upload("log.md", "first");
    await save(f.id, "second", 0); // window 0 → always append

    const versions = await svc.listVersions({ sub: USER }, f.id);
    expect(versions).toHaveLength(2);
    expect(versions[0]!.createdByLabel).toBe("Me");
    const head = await svc.getFile({ sub: USER }, f.id);
    expect(versions[0]!.id).toBe(head.currentVersionId); // newest first → current on top
  });

  it("restoreVersion makes an old version current as a new, non-destructive entry", async () => {
    const f = await upload("essay.md", "draft one");
    const v1 = f.currentVersionId!;
    const v1Key = f.version!.blobKey!;
    const updated = await save(f.id, "draft two", 0); // append → 2 versions
    const v2 = updated.currentVersionId!;

    const restored = await svc.restoreVersion({ sub: USER }, f.id, v1);
    // A brand-new current version (not v1 or v2 reused) holding v1's content.
    expect(restored.currentVersionId).not.toBe(v1);
    expect(restored.currentVersionId).not.toBe(v2);
    expect(restored.version!.blobKey).toBe(v1Key);
    expect(await new Response(await store.store.get(restored.version!.blobKey!)).text()).toBe("draft one");
    // History grew to three; the two originals are intact.
    expect(await svc.listVersions({ sub: USER }, f.id)).toHaveLength(3);
    // v1's blob is now referenced twice (the original v1 + the restore).
    expect((await db.first<{ ref_count: number }>("SELECT ref_count FROM blobs WHERE hash = ?", [v1Key]))?.ref_count).toBe(2);
  });

  it("getVersionContentKey streams the bytes of a specific past version", async () => {
    const f = await upload("essay.md", "draft one");
    const v1 = f.currentVersionId!;
    const updated = await save(f.id, "draft two", 0); // append → current is draft two
    const v2 = updated.currentVersionId!;

    const old = await svc.getVersionContentKey({ sub: USER }, f.id, v1);
    expect(await new Response(await store.store.get(old.key)).text()).toBe("draft one");
    const cur = await svc.getVersionContentKey({ sub: USER }, f.id, v2);
    expect(await new Response(await store.store.get(cur.key)).text()).toBe("draft two");

    await expect(svc.getVersionContentKey({ sub: USER }, f.id, "nope")).rejects.toThrow();
  });

  it("pruneFileVersions thins old snapshots but keeps current + pinned, releasing dropped blobs", async () => {
    const f = await upload("log.md", "v1");
    const v1 = f.currentVersionId!;
    const v1Key = f.version!.blobKey!;
    await save(f.id, "v2", 0); // append
    await save(f.id, "v3", 0); // append
    const updated = await save(f.id, "v4", 0); // append → current
    const v4 = updated.currentVersionId!;
    expect(await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM blobs").then((r) => r!.n)).toBe(4);

    // Pin the oldest so retention must keep it despite its age.
    await svc.keepVersion({ sub: USER }, f.id, v1, true);

    // Far in the future, all four sit in one ~monthly bucket. Current (v4) and pinned
    // (v1) are always kept; of the two remaining (v2, v3) the curve keeps the newest
    // in the bucket → exactly one snapshot is pruned and its blob released.
    const future = Date.now() + 40 * 24 * 3_600_000;
    const pruned = await svc.pruneFileVersions(f.id, future);
    expect(pruned).toBe(1);

    const remaining = await svc.listVersions({ sub: USER }, f.id);
    expect(remaining).toHaveLength(3);
    const ids = remaining.map((v) => v.id);
    expect(ids).toContain(v1); // pinned survives
    expect(ids).toContain(v4); // current survives
    // One blob was released (the pruned snapshot); the pinned version's blob remains.
    expect(await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM blobs").then((r) => r!.n)).toBe(3);
    expect(await db.first("SELECT 1 FROM blobs WHERE hash = ?", [v1Key])).not.toBeNull();
  });

  it("keepVersion rejects an unknown version id", async () => {
    const f = await upload("log.md", "v1");
    await expect(svc.keepVersion({ sub: USER }, f.id, "nope", true)).rejects.toThrow();
  });

  it("a different author's save appends rather than coalescing (authorship boundary)", async () => {
    const fam = await svc.createSpace({ sub: USER }, { name: "Family" });
    await addMember(db, fam.id, "bob", "editor");

    const v1 = enc("v1");
    const h1 = await sha256hex(v1);
    await svc.prepareUpload(fam.id, USER, h1);
    await svc.commitUpload(fam.id, USER, h1, v1);
    const f = await svc.createFile(fam.id, USER, { name: "shared.md", hash: h1, mime: "text/plain" });

    const v2 = enc("v2 by bob");
    const h2 = await sha256hex(v2);
    await svc.prepareUpload(fam.id, "bob", h2);
    await svc.commitUpload(fam.id, "bob", h2, v2);
    await svc.addVersion({ sub: "bob" }, f.id, { hash: h2, mime: "text/plain" }); // within window, different author

    expect(await svc.listVersions({ sub: USER }, f.id)).toHaveLength(2);
  });

  it("a file-share editor saves a new version via the file-scoped upload (blob lands in the file's space)", async () => {
    // USER owns a file in their own space and shares it (file grant only) with bob,
    // who has NO membership or folder grant on that space.
    const f = await upload("shared-note.md", "v1");
    await svc.shareGrant({ sub: USER }, f.id, { subjectType: "user", subjectId: "bob", role: "editor" });

    // bob can't stage via the space-scoped flow — he holds no space/folder role.
    // That gap is exactly why blobs used to land in the wrong space and addVersion 409'd.
    const v2 = enc("v2 by bob");
    const h2 = await sha256hex(v2);
    await expect(svc.prepareUpload(space, "bob", h2)).rejects.toBeInstanceOf(PermissionError);

    // The file-scoped flow gates on editor of the file and keys the blob to the
    // file's own space, so addVersion finds it.
    const prep = await svc.prepareFileUpload({ sub: "bob" }, f.id, h2);
    if (!prep.exists) await svc.commitFileUpload({ sub: "bob" }, f.id, h2, v2);
    const updated = await svc.addVersion({ sub: "bob" }, f.id, { hash: h2, mime: "text/plain", coalesce: false });

    expect(updated.currentVersionId).not.toBe(f.currentVersionId);
    expect(await new Response(await store.store.get(updated.version!.blobKey!)).text()).toBe("v2 by bob");

    // A viewer (read-only) can't stage a version.
    await svc.shareGrant({ sub: USER }, f.id, { subjectType: "user", subjectId: "carol", role: "viewer" });
    await expect(svc.prepareFileUpload({ sub: "carol" }, f.id, h2)).rejects.toBeInstanceOf(PermissionError);
  });

  it("a folder-grant editor (no space membership) can upload via the blob flow", async () => {
    const fam = await svc.createSpace({ sub: USER }, { name: "Family" });
    await svc.createFolder(fam.id, USER, "Shared");
    // bob gets editor on the Shared folder only — he is NOT a member of the space.
    await svc.shareFolderGrant({ sub: USER }, fam.id, "Shared", { subjectType: "user", subjectId: "bob", role: "editor" });

    const bytes = enc("bob's upload");
    const hash = await sha256hex(bytes);
    // The blob-staging step (issue #15): used to require space editor, now allows
    // anyone holding editor on some path in the space. createFile then gates the
    // destination, so bob can write into the folder he was granted.
    const prep = await svc.prepareUpload(fam.id, "bob", hash);
    if (!prep.exists) await svc.commitUpload(fam.id, "bob", hash, bytes);
    const f = await svc.createFile(fam.id, "bob", { name: "note.txt", hash, mime: "text/plain", path: "Shared" });
    expect(f.name).toBe("note.txt");

    // …but the destination is still gated: bob can't create outside the shared folder.
    await expect(
      svc.createFile(fam.id, "bob", { name: "rogue.txt", hash, mime: "text/plain", path: "" }),
    ).rejects.toBeInstanceOf(PermissionError);

    // …and a user with no grant at all can't even stage a blob.
    await expect(svc.prepareUpload(fam.id, "carol", hash)).rejects.toBeInstanceOf(PermissionError);
  });

  it("purge releases a ref; the blob is removed only at ref_count 0", async () => {
    const a = await upload("a.txt", "shared");
    const b = await upload("b.txt", "shared");
    const key = a.version!.blobKey!;

    await svc.purgeFile({ sub: USER }, a.id); // ref 2 → 1, blob kept
    expect(store.map.has(key)).toBe(true);
    expect((await db.first<{ ref_count: number }>("SELECT ref_count FROM blobs WHERE hash = ?", [key]))?.ref_count).toBe(1);

    await svc.purgeFile({ sub: USER }, b.id); // ref 1 → 0, blob gone
    expect(store.map.has(key)).toBe(false);
    expect(await db.first("SELECT 1 FROM blobs WHERE hash = ?", [key])).toBeNull();
  });

  it("deleteSpace removes the space and everything scoped to it, releasing blobs", async () => {
    const fam = await svc.createSpace({ sub: USER }, { name: "Family" });
    await addMember(db, fam.id, "bob", "editor");
    await svc.createFolder(fam.id, USER, "Shared");
    await svc.applySpacePlugin({ sub: USER }, fam.id, "notes");
    await svc.createSpaceInvite({ sub: USER }, fam.id, "viewer");

    // A file that lives only in this space — its blob has a single ref.
    const bytes = enc("only in the family space");
    const hash = await sha256hex(bytes);
    await svc.prepareUpload(fam.id, USER, hash);
    await svc.commitUpload(fam.id, USER, hash, bytes);
    const f = await svc.createFile(fam.id, USER, { name: "doc.md", hash, mime: "text/plain" });
    const key = f.version!.blobKey!;
    expect(store.map.has(key)).toBe(true);

    // A non-owner can't delete it.
    await expect(svc.deleteSpace({ sub: "bob" }, fam.id)).rejects.toBeInstanceOf(PermissionError);
    // Neither can anyone delete a personal ("My Drive") space.
    await expect(svc.deleteSpace({ sub: USER }, space)).rejects.toBeInstanceOf(PermissionError);

    await svc.deleteSpace({ sub: USER }, fam.id);

    // The space, its file, and the sole blob ref are gone.
    expect(await db.first("SELECT 1 FROM spaces WHERE id = ?", [fam.id])).toBeNull();
    expect(await db.first("SELECT 1 FROM files WHERE id = ?", [f.id])).toBeNull();
    expect(store.map.has(key)).toBe(false);
    expect(await db.first("SELECT 1 FROM blobs WHERE hash = ?", [key])).toBeNull();

    // And so is everything scoped to it: members/grants, folders, plugins, invites.
    const count = async (sql: string) => (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${sql}`, [fam.id]))?.n;
    expect(await count("relation_tuples WHERE object_type = 'space' AND object_id = ?")).toBe(0);
    expect(await count("folders WHERE space_id = ?")).toBe(0);
    expect(await count("space_plugins WHERE space_id = ?")).toBe(0);
    expect(await count("space_invites WHERE space_id = ?")).toBe(0);

    // It no longer shows up for its members.
    expect((await svc.spaces(USER)).some((s) => s.id === fam.id)).toBe(false);
  });

  it("delete moves a file to Trash without destroying content; restore brings it back", async () => {
    const f = await upload("draft.txt", "keep me", { path: "Docs" });
    const key = f.version!.blobKey!;
    const versionId = f.currentVersionId;

    await svc.deleteFile({ sub: USER }, f.id);
    // Hidden from listings, but content (version + blob) is untouched.
    expect((await svc.list(USER, space, "Docs")).files).toHaveLength(0);
    expect(store.map.has(key)).toBe(true);
    expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM file_versions WHERE file_id = ?", [f.id]))?.n).toBe(1);
    // It surfaces in Trash.
    expect((await svc.listTrash(USER)).map((x) => x.name)).toEqual(["draft.txt"]);

    await svc.restoreFile({ sub: USER }, f.id);
    expect((await svc.listTrash(USER))).toHaveLength(0);
    const restored = await svc.getFile({ sub: USER }, f.id);
    expect(restored.name).toBe("draft.txt");
    expect(restored.currentVersionId).toBe(versionId); // same content, intact
    expect((await svc.list(USER, space, "Docs")).files.map((x) => x.name)).toEqual(["draft.txt"]);
  });

  it("purge permanently removes a trashed file, its versions, grants, and releases the blob", async () => {
    const f = await upload("gone.txt", "bye for good");
    const key = f.version!.blobKey!;
    await svc.shareGrant({ sub: USER }, f.id, { subjectType: "user", subjectId: "bob", role: "viewer" });

    await svc.deleteFile({ sub: USER }, f.id);
    await svc.purgeFile({ sub: USER }, f.id);

    expect(await svc.listTrash(USER)).toHaveLength(0);
    expect(store.map.has(key)).toBe(false);
    expect(await db.first("SELECT 1 FROM files WHERE id = ?", [f.id])).toBeNull();
    expect(await db.first("SELECT 1 FROM file_versions WHERE file_id = ?", [f.id])).toBeNull();
    expect(await db.first("SELECT 1 FROM relation_tuples WHERE object_type = 'file' AND object_id = ?", [f.id])).toBeNull();
  });

  it("restore and purge require owner", async () => {
    const f = await upload("mine.txt", "x");
    await svc.shareGrant({ sub: USER }, f.id, { subjectType: "user", subjectId: "bob", role: "viewer" });
    await svc.deleteFile({ sub: USER }, f.id);

    await expect(svc.restoreFile({ sub: "bob" }, f.id)).rejects.toBeInstanceOf(PermissionError);
    await expect(svc.purgeFile({ sub: "bob" }, f.id)).rejects.toBeInstanceOf(PermissionError);
    // still recoverable by the owner
    expect((await svc.listTrash(USER)).map((x) => x.name)).toEqual(["mine.txt"]);
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

  it("getFileForDisplay returns a single file enriched like a listing item", async () => {
    await upsertUser(db, { sub: USER, email: "me@x.com", name: "Me" });
    const f = await upload("doc.md", "hi");
    await svc.shareGrant({ sub: USER }, f.id, { subjectType: "email", subjectId: "friend@x.com", role: "viewer" });

    const item = await svc.getFileForDisplay({ sub: USER }, f.id);
    expect(item.name).toBe("doc.md");
    expect(item.ownerLabel).toBe("Me");
    expect(item.sharedWith).toContain("friend@x.com");
    expect(item.version?.size).toBe(2);
    // same access control as getFile — a stranger is refused
    await expect(svc.getFileForDisplay({ sub: "intruder" }, f.id)).rejects.toBeInstanceOf(PermissionError);
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
    const fam = await svc.createSpace({ sub: USER }, { name: "Family" });
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
    const fam = await svc.createSpace({ sub: USER }, { name: "Team" });
    await expect(svc.createSpaceInvite({ sub: "stranger" }, fam.id, "viewer")).rejects.toBeInstanceOf(PermissionError);

    const invite = await svc.createSpaceInvite({ sub: USER }, fam.id, "viewer");
    await svc.revokeSpaceInvite({ sub: USER }, fam.id, invite.token);
    expect((await svc.inviteInfo(invite.token)).status).toBe("not_found");
    await expect(svc.acceptSpaceInvite({ sub: "bob" }, invite.token)).rejects.toThrow(/invite not found/);
  });
});
