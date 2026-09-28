/**
 * Rename and trash (#74) — the two claims that are not obvious.
 *
 * **A folder rename touches paths and nothing else.** This is the whole reason the
 * model stopped addressing files by path. In `@canopy/store` a folder rename rewrote
 * every descendant's identity, and every grant that named one; here `path` is a
 * derived column beside the parent edge, so the rename moves strings and leaves the
 * permission graph alone. Asserted by giving someone a grant deep in the tree,
 * renaming an ancestor, and checking they still reach the same file.
 *
 * **A trashed file leaves every read but the trash listing.** Including search, which
 * is the one easiest to forget: a hit that opens a 404 is worse than no hit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { DRIVE_PERM, ROOT_FOLDER_ID, driveManifest, driveModule } from '../src/index.js';
import { ROLES } from '../src/provision.js';

let dir: string;
let host: ScopeHost;

const staff = platformActorId.parse(ulid());
const tenant = tenantId.parse(ulid());
const scope = scopeId.parse(ulid());
/** Holds the root: makes the world. */
const ada = principalId.parse(ulid());
/** NOT a member. One grant, deep in the tree, and nothing at the node. */
const cleo = principalId.parse(ulid());
/** A member: reads the space, and holds write only where he is given it. */
const bjorn = principalId.parse(ulid());

interface FileRow {
  id: string;
  name: string;
  folder_id: string;
  state: string;
  deleted_at: string | null;
}
interface FolderRow {
  id: string;
  path: string;
  name: string;
}

const as = (who: typeof ada) => host.getScope(who, tenant, scope);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'canopy-drive-trash-'));
  host = new SqliteScopeHost({ dir });
  host.registerModule(driveModule);

  await host.admin.createTenant(staff, { id: tenant, slug: 'trash', name: 'Trash' });
  await host.admin.grantEntitlement(staff, tenant, driveManifest.entitlementKey as string);
  await host.provisionScope(staff, { tenantId: tenant, scopeId: scope, vertical: 'drive' });
  await host.provisionBlobStore(staff, { tenantId: tenant, vertical: 'drive', binding: 'BLOBS' });
  await host.admin.activateScope(staff, tenant, scope);
  for (const role of ROLES) await host.admin.defineRole(staff, tenant, role);
  for (const p of [ada, bjorn]) {
    await host.admin.assignRole(staff, {
      principalId: p,
      roleKey: 'member',
      node: { tenantId: tenant, scopeId: scope },
    });
  }
  for (const permission of [DRIVE_PERM.write, DRIVE_PERM.manage]) {
    await host.admin.grant(staff, {
      principalId: ada,
      permission,
      node: { tenantId: tenant, scopeId: scope },
      entity: { entityType: 'folder', entityId: ROOT_FOLDER_ID },
      grantedBy: ada,
    });
  }
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('a rename moves names and paths, and nothing else', () => {
  it('refuses a name the folder already holds', async () => {
    const stub = await as(ada);
    const folder = await stub.invoke<FolderRow>('drive/create-folder', {
      parentId: ROOT_FOLDER_ID,
      name: 'Conflicts',
    });
    await stub.invoke('drive/ensure-file', { folderId: folder.id, name: 'taken.md' });
    const second = await stub.invoke<FileRow>('drive/ensure-file', {
      folderId: folder.id,
      name: 'mine.md',
    });

    await expect(
      stub.invoke('drive/rename-file', { fileId: second.id, name: 'taken.md' }),
    ).rejects.toThrow(/already has/);

    // …and the same name is a no-op rather than a conflict with itself.
    const same = await stub.invoke<FileRow>('drive/rename-file', {
      fileId: second.id,
      name: 'mine.md',
    });
    expect(same.name).toBe('mine.md');
  });

  it('re-derives a whole subtree, leaving every grant reaching what it reached', async () => {
    const stub = await as(ada);
    const outer = await stub.invoke<FolderRow>('drive/create-folder', {
      parentId: ROOT_FOLDER_ID,
      name: 'Papers',
    });
    const inner = await stub.invoke<FolderRow>('drive/create-folder', {
      parentId: outer.id,
      name: '2026',
    });
    const deep = await stub.invoke<FileRow>('drive/ensure-file', {
      folderId: inner.id,
      name: 'lease.pdf',
    });
    expect(inner.path).toBe('Papers/2026');

    // Cleo is not a member: her ONLY reach is this grant, two levels down. If a rename
    // rewrote parent edges or grants, this is what would break.
    await host.admin.grant(staff, {
      principalId: cleo,
      permission: DRIVE_PERM.read,
      node: { tenantId: tenant, scopeId: scope },
      entity: { entityType: 'folder', entityId: inner.id },
      grantedBy: ada,
    });
    const before = await (await as(cleo)).invoke<{ file: FileRow }>('drive/get-file', {
      fileId: deep.id,
    });
    expect(before.file.id).toBe(deep.id);

    const renamed = await stub.invoke<FolderRow>('drive/rename-folder', {
      folderId: outer.id,
      name: 'Documents',
    });
    expect(renamed.path).toBe('Documents');

    // The subtree's paths moved…
    const movedInner = await stub.invoke<FolderRow | null>('drive/folder-by-path', {
      path: 'Documents/2026',
    });
    expect(movedInner?.id).toBe(inner.id);
    expect(await stub.invoke('drive/folder-by-path', { path: 'Papers/2026' })).toBeNull();

    // …and Cleo still reaches exactly the file she could reach before, through a grant
    // nobody touched. This is the claim the model change rests on.
    const after = await (await as(cleo)).invoke<{ file: FileRow }>('drive/get-file', {
      fileId: deep.id,
    });
    expect(after.file.id).toBe(deep.id);
  });

  it('treats % and _ in a path as characters, not wildcards', async () => {
    const stub = await as(ada);
    // `segment` permits both, so a `LIKE old || '/%'` guard reads them as wildcards:
    // renaming `Notes_1` would match `NotesA1/child` and rewrite a stranger's path
    // while leaving its parent edge pointing somewhere else entirely.
    const underscore = await stub.invoke<FolderRow>('drive/create-folder', {
      parentId: ROOT_FOLDER_ID,
      name: 'Notes_1',
    });
    await stub.invoke('drive/create-folder', { parentId: underscore.id, name: 'inside' });
    const lookalike = await stub.invoke<FolderRow>('drive/create-folder', {
      parentId: ROOT_FOLDER_ID,
      name: 'NotesA1',
    });
    await stub.invoke('drive/create-folder', { parentId: lookalike.id, name: 'child' });

    await stub.invoke('drive/rename-folder', { folderId: underscore.id, name: 'Renamed' });

    expect(
      (await stub.invoke<FolderRow | null>('drive/folder-by-path', { path: 'Renamed/inside' }))?.name,
    ).toBe('inside');
    // The lookalike is untouched: same path it was created with.
    expect(
      (await stub.invoke<FolderRow | null>('drive/folder-by-path', { path: 'NotesA1/child' }))?.name,
    ).toBe('child');
  });

  it('will not rename a sibling whose path merely starts the same way', async () => {
    const stub = await as(ada);
    // 'Papers' is gone (renamed above), so this is a fresh pair whose prefixes overlap:
    // a LIKE 'Notes%' guard would catch 'Notes archive' and re-root it under 'Ideas'.
    const notes = await stub.invoke<FolderRow>('drive/create-folder', {
      parentId: ROOT_FOLDER_ID,
      name: 'Notes',
    });
    await stub.invoke('drive/create-folder', { parentId: ROOT_FOLDER_ID, name: 'Notes archive' });

    await stub.invoke('drive/rename-folder', { folderId: notes.id, name: 'Ideas' });

    const sibling = await stub.invoke<FolderRow | null>('drive/folder-by-path', {
      path: 'Notes archive',
    });
    expect(sibling?.name).toBe('Notes archive');
  });
});

describe('trash is recoverable, and leaves every other read', () => {
  let folder: string;
  let doomed: string;

  it('a trashed file is gone from the listing and present in the trash', async () => {
    const stub = await as(ada);
    folder = (
      await stub.invoke<FolderRow>('drive/create-folder', {
        parentId: ROOT_FOLDER_ID,
        name: 'Trashable',
      })
    ).id;
    const file = await stub.invoke<FileRow>('drive/ensure-file', {
      folderId: folder,
      name: 'oops.md',
    });
    doomed = file.id;

    const trashed = await stub.invoke<FileRow>('drive/trash-file', { fileId: doomed });
    expect(trashed.state).toBe('trashed');
    // The two columns are written together or the reads disagree with each other.
    expect(trashed.deleted_at).not.toBeNull();

    const listing = await stub.invoke<{ entries: FileRow[] }>('drive/list-folder', {
      folderId: folder,
    });
    expect(listing.entries).toEqual([]);

    const bin = await stub.invoke<{ entries: FileRow[] }>('drive/list-trash', {});
    expect(bin.entries.map((f) => f.id)).toContain(doomed);
  });

  it('a trashed file is gone from every read but the bin', async () => {
    const stub = await as(ada);
    // Not a state-specific error: to a caller the file is gone, and an error that said
    // "trashed" would hand back the existence of something they were not shown.
    await expect(stub.invoke('drive/get-file', { fileId: doomed })).rejects.toThrow(/not found/);
    await expect(stub.invoke('drive/file-versions', { fileId: doomed })).rejects.toThrow(/not found/);
    await expect(stub.invoke('drive/file-text', { fileId: doomed })).rejects.toThrow(/not found/);
  });

  it('refuses a version written to something in the trash', async () => {
    const stub = await as(ada);
    // This used to clear `deleted_at` while leaving `state = 'trashed'` — a row whose
    // two halves disagreed, which the trash listing would then report as trashed with
    // no timestamp. Refused instead: restore it first.
    await expect(
      stub.invoke('drive/record-version', {
        fileId: doomed,
        location: { source: 'external', externalKey: 'resurrect', mime: 'text/plain', size: 1 },
      }),
    ).rejects.toThrow(/in the trash/);
  });

  it('refuses a rename of something in the trash', async () => {
    const stub = await as(ada);
    // `ctx.check` says nothing about state, so without the `liveFile` guard a writer
    // could rename a trashed row and emit `drive.file-renamed` about it. Restore is the
    // only write that reaches through the trash.
    await expect(
      stub.invoke('drive/rename-file', { fileId: doomed, name: 'renamed-in-the-bin.md' }),
    ).rejects.toThrow(/not found/);
  });

  it('a trashed file is not a search hit', async () => {
    const stub = await as(ada);
    const hits = await stub.invoke<{ hits: { id: string }[] }>('drive/search', { term: 'oops' });
    expect(hits.hits.map((h) => h.id)).not.toContain(doomed);
  });

  it('its name is held until it is restored, and says so', async () => {
    const stub = await as(ada);
    // Not a silent resurrection and not a raw UNIQUE failure: the name is taken by
    // something in the trash, and the caller is told which choice they have.
    await expect(
      stub.invoke('drive/ensure-file', { folderId: folder, name: 'oops.md' }),
    ).rejects.toThrow(/trashed file holds the name/);

    const restored = await stub.invoke<FileRow>('drive/restore-file', { fileId: doomed });
    expect(restored.state).toBe('live');
    expect(restored.deleted_at).toBeNull();

    const listing = await stub.invoke<{ entries: FileRow[] }>('drive/list-folder', {
      folderId: folder,
    });
    expect(listing.entries.map((f) => f.id)).toEqual([doomed]);
  });

  it('a rename cannot take a trashed neighbour\'s name either', async () => {
    const stub = await as(ada);
    const file = await stub.invoke<FileRow>('drive/ensure-file', {
      folderId: folder,
      name: 'contested.md',
    });
    await stub.invoke('drive/trash-file', { fileId: file.id });

    const other = await stub.invoke<FileRow>('drive/ensure-file', {
      folderId: folder,
      name: 'other.md',
    });
    // The reservation holds against BOTH ways in — creating and renaming — which is
    // what makes a restore unable to fail: nothing can have taken the name meanwhile.
    await expect(
      stub.invoke('drive/rename-file', { fileId: other.id, name: 'contested.md' }),
    ).rejects.toThrow(/already has/);

    const restored = await stub.invoke<FileRow>('drive/restore-file', { fileId: file.id });
    expect(restored.state).toBe('live');
  });
});

describe('the trash walk does not end at other people\'s files', () => {
  it('keeps a cursor whenever the scan filled its batch', async () => {
    const stub = await as(ada);
    // Cleo reaches ONE folder. With limit 1 the handler scans four rows per pass, so
    // her file sitting behind four of Ada's is exactly the case that used to end the
    // walk: a full batch with nothing visible in it returned no cursor at all.
    const hidden = await stub.invoke<FolderRow>('drive/create-folder', {
      parentId: ROOT_FOLDER_ID,
      name: 'Hidden',
    });
    const shared = await stub.invoke<FolderRow>('drive/create-folder', {
      parentId: ROOT_FOLDER_ID,
      name: 'Shared',
    });
    await host.admin.grant(staff, {
      principalId: cleo,
      permission: DRIVE_PERM.read,
      node: { tenantId: tenant, scopeId: scope },
      entity: { entityType: 'folder', entityId: shared.id },
      grantedBy: ada,
    });

    // Four in the folder she cannot read, then one she can — ULIDs are creation
    // ordered, so this is also the order the walk sees them in.
    for (const name of ['a.md', 'b.md', 'c.md', 'd.md']) {
      const f = await stub.invoke<FileRow>('drive/ensure-file', { folderId: hidden.id, name });
      await stub.invoke('drive/trash-file', { fileId: f.id });
    }
    const hers = await stub.invoke<FileRow>('drive/ensure-file', {
      folderId: shared.id,
      name: 'hers.md',
    });
    await stub.invoke('drive/trash-file', { fileId: hers.id });

    const cleoStub = await as(cleo);
    const seen: string[] = [];
    let cursor: string | null = null;
    // Bounded: a walk that cannot end is the other failure, and this asserts it ends.
    for (let page = 0; page < 6; page++) {
      const res: { entries: FileRow[]; nextCursor?: string | null } = await cleoStub.invoke(
        'drive/list-trash',
        cursor ? { limit: 1, cursor } : { limit: 1 },
      );
      seen.push(...res.entries.map((f) => f.id));
      cursor = res.nextCursor ?? null;
      if (!cursor) break;
    }
    expect(seen).toContain(hers.id);
    expect(cursor).toBeNull();
  });

  it('walks every readable row when the page fills before the batch ends', async () => {
    const stub = await as(ada);
    // The other half of the same walk, and the one the sparse test cannot reach: with
    // `limit: 1` the page fills on the FIRST row while the batch (four) is not
    // saturated, so a cursor keyed on saturation alone would drop the rest.
    const folder = (
      await stub.invoke<FolderRow>('drive/create-folder', {
        parentId: ROOT_FOLDER_ID,
        name: 'Dense',
      })
    ).id;
    const ids: string[] = [];
    for (const name of ['one.md', 'two.md', 'three.md']) {
      const f = await stub.invoke<FileRow>('drive/ensure-file', { folderId: folder, name });
      await stub.invoke('drive/trash-file', { fileId: f.id });
      ids.push(f.id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 12; page++) {
      const res: { entries: FileRow[]; nextCursor?: string | null } = await stub.invoke(
        'drive/list-trash',
        cursor ? { limit: 1, cursor } : { limit: 1 },
      );
      seen.push(...res.entries.map((f) => f.id));
      cursor = res.nextCursor ?? null;
      if (!cursor) break;
    }
    for (const id of ids) expect(seen).toContain(id);
    expect(cursor).toBeNull();
  });
});

describe('a move takes access with it', () => {
  it('hands a folder and its subtree to whoever can reach the new parent', async () => {
    const stub = await as(ada);
    const personal = await stub.invoke<FolderRow>('drive/create-folder', {
      parentId: ROOT_FOLDER_ID,
      name: 'Personal',
    });
    const shared = await stub.invoke<FolderRow>('drive/create-folder', {
      parentId: ROOT_FOLDER_ID,
      name: 'Family',
    });
    const year = await stub.invoke<FolderRow>('drive/create-folder', {
      parentId: personal.id,
      name: '2026',
    });
    const deep = await stub.invoke<FileRow>('drive/ensure-file', {
      folderId: year.id,
      name: 'lease.pdf',
    });

    // Cleo is not a member. Her whole reach is one grant on Family — so before the move she
    // cannot see a file that lives under Personal.
    await host.admin.grant(staff, {
      principalId: cleo,
      permission: DRIVE_PERM.read,
      node: { tenantId: tenant, scopeId: scope },
      entity: { entityType: 'folder', entityId: shared.id },
      grantedBy: ada,
    });
    await expect(
      (await as(cleo)).invoke('drive/get-file', { fileId: deep.id }),
    ).rejects.toThrow();

    // Dragging 2026 into Family is the sharing decision (#75), and the kernel's relink is
    // what carries it: one atomic replace of the edge, so the grant above Family now
    // reaches everything under 2026 — including a file two levels down.
    const moved = await stub.invoke<FolderRow>('drive/move-folder', {
      folderId: year.id,
      parentId: shared.id,
    });
    expect(moved.path).toBe('Family/2026');

    const seen = await (await as(cleo)).invoke<{ file: FileRow }>('drive/get-file', {
      fileId: deep.id,
    });
    expect(seen.file.id).toBe(deep.id);
  });

  it('takes access AWAY from the folder it left', async () => {
    const stub = await as(ada);
    const from = await stub.invoke<FolderRow>('drive/create-folder', {
      parentId: ROOT_FOLDER_ID,
      name: 'Lent',
    });
    const to = await stub.invoke<FolderRow>('drive/create-folder', {
      parentId: ROOT_FOLDER_ID,
      name: 'Private',
    });
    const file = await stub.invoke<FileRow>('drive/ensure-file', { folderId: from.id, name: 'note.md' });

    await host.admin.grant(staff, {
      principalId: cleo,
      permission: DRIVE_PERM.read,
      node: { tenantId: tenant, scopeId: scope },
      entity: { entityType: 'folder', entityId: from.id },
      grantedBy: ada,
    });
    expect((await (await as(cleo)).invoke<{ file: FileRow }>('drive/get-file', { fileId: file.id })).file.id).toBe(file.id);

    await stub.invoke('drive/move-file', { fileId: file.id, folderId: to.id });

    // The half that makes "grants follow" a rule rather than a widening: the old edge is
    // tombstoned, so Cleo's grant on Lent no longer reaches a file that is not in Lent.
    await expect(
      (await as(cleo)).invoke('drive/get-file', { fileId: file.id }),
    ).rejects.toThrow();
  });

  it('refuses a move by someone who can write only where it is going', async () => {
    const stub = await as(ada);
    const locked = await stub.invoke<FolderRow>('drive/create-folder', {
      parentId: ROOT_FOLDER_ID,
      name: 'Locked',
    });
    const open = await stub.invoke<FolderRow>('drive/create-folder', {
      parentId: ROOT_FOLDER_ID,
      name: 'Open',
    });
    const secret = await stub.invoke<FileRow>('drive/ensure-file', {
      folderId: locked.id,
      name: 'secret.md',
    });

    // Björn can write in Open and has nothing on Locked. If a move checked only the
    // destination he could pull the file into Open — and because access FOLLOWS a move, he
    // would then be entitled to read it. That is granting yourself access to content
    // nobody shared, which is why both ends are checked.
    await host.admin.grant(staff, {
      principalId: bjorn,
      permission: DRIVE_PERM.write,
      node: { tenantId: tenant, scopeId: scope },
      entity: { entityType: 'folder', entityId: open.id },
      grantedBy: ada,
    });

    await expect(
      (await as(bjorn)).invoke('drive/move-file', { fileId: secret.id, folderId: open.id }),
    ).rejects.toThrow();

    // Still where it was, and still Ada's.
    const where = await stub.invoke<{ file: FileRow }>('drive/get-file', { fileId: secret.id });
    expect(where.file.folder_id).toBe(locked.id);
  });

  it('refuses a move onto a name the destination’s trash still holds', async () => {
    const stub = await as(ada);
    const here = await stub.invoke<FolderRow>('drive/create-folder', {
      parentId: ROOT_FOLDER_ID,
      name: 'Here',
    });
    const there = await stub.invoke<FolderRow>('drive/create-folder', {
      parentId: ROOT_FOLDER_ID,
      name: 'There',
    });

    // A trashed file keeps its name (#74), and `(folder_id, name)` is unique regardless of
    // state — so a check that looked only at live rows would pass and then hit the
    // constraint, turning a conflict into a database error.
    const doomedThere = await stub.invoke<FileRow>('drive/ensure-file', {
      folderId: there.id,
      name: 'report.pdf',
    });
    await stub.invoke('drive/trash-file', { fileId: doomedThere.id });

    const mine = await stub.invoke<FileRow>('drive/ensure-file', {
      folderId: here.id,
      name: 'report.pdf',
    });
    await expect(
      stub.invoke('drive/move-file', { fileId: mine.id, folderId: there.id }),
    ).rejects.toThrow(/trashed file in that folder holds the name/);

    // And it is still where it was.
    expect(
      (await stub.invoke<{ file: FileRow }>('drive/get-file', { fileId: mine.id })).file.folder_id,
    ).toBe(here.id);
  });

  it('refuses a folder moving inside itself, and a name already taken', async () => {
    const stub = await as(ada);
    const outer = await stub.invoke<FolderRow>('drive/create-folder', {
      parentId: ROOT_FOLDER_ID,
      name: 'Outer',
    });
    const inner = await stub.invoke<FolderRow>('drive/create-folder', {
      parentId: outer.id,
      name: 'Inner',
    });

    await expect(
      stub.invoke('drive/move-folder', { folderId: outer.id, parentId: inner.id }),
    ).rejects.toThrow(/inside itself/);
    await expect(
      stub.invoke('drive/move-folder', { folderId: outer.id, parentId: outer.id }),
    ).rejects.toThrow(/inside itself/);

    // And a collision at the destination is a conflict, not an overwrite.
    const other = await stub.invoke<FolderRow>('drive/create-folder', {
      parentId: ROOT_FOLDER_ID,
      name: 'Collide',
    });
    await stub.invoke('drive/create-folder', { parentId: other.id, name: 'Inner' });
    await expect(
      stub.invoke('drive/move-folder', { folderId: inner.id, parentId: other.id }),
    ).rejects.toThrow(/already exists/);
  });
});
