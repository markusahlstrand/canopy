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
  await host.admin.assignRole(staff, {
    principalId: ada,
    roleKey: 'member',
    node: { tenantId: tenant, scopeId: scope },
  });
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
