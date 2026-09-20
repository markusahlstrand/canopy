/**
 * The drive, converted: what a space looks like once it is a scope.
 *
 * Every assertion here is about the move rather than about the drive. The drive
 * already works — `@canopy/store` has had these operations for a year. What is
 * being proved is that they still work when the space id is gone, the database is
 * per-scope, and permission is the kernel's rather than `authz.ts`'s.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { principalId, platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { driveModule, driveManifest, DRIVE_PERM, ROOT_FOLDER_ID, driveMigrations } from '../src/index.js';
import { ROLES } from '../src/provision.js';

/**
 * Everyone below is assigned `member` from the SHIPPED role table above, which holds
 * `drive:read` and nothing else: canopy's space membership already means "you see this
 * space's drive" — a family space is shared by being a space, not by granting every
 * folder in it.
 *
 * Write comes from a grant on a folder entity, reaching everything beneath it through
 * the declared parent edge — what `folder_grants` + the `pathRole` walk did by hand,
 * one ancestor at a time. The `owner` role beside `member` is the PROVISIONING path,
 * exercised by a deploy; these tests are about the SHARING path, where a permission has
 * to travel down an edge to mean anything.
 */

let dir: string;
let host: ScopeHost;

const staff = platformActorId.parse(ulid());
const tenant = tenantId.parse(ulid());
const scope = scopeId.parse(ulid());
const otherTenant = tenantId.parse(ulid());
const otherScope = scopeId.parse(ulid());
const ada = principalId.parse(ulid());
const bjorn = principalId.parse(ulid());
const cleo = principalId.parse(ulid());

interface FileRow {
  id: string;
  folder_id: string;
  name: string;
  current_version_id: string | null;
}
interface FolderRow {
  id: string;
  path: string;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scope-drive-'));
  host = new SqliteScopeHost({ dir });
  host.registerModule(driveModule);

  for (const [t, s, people] of [
    [tenant, scope, [ada, bjorn]],
    [otherTenant, otherScope, [cleo]],
  ] as const) {
    await host.admin.createTenant(staff, {
      id: t,
      slug: `drive-${t.slice(-6).toLowerCase()}`,
      name: 'Drive',
    });
    await host.admin.grantEntitlement(staff, t, driveManifest.entitlementKey as string);
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'drive' });
    await host.admin.activateScope(staff, t, s);
    for (const role of ROLES) await host.admin.defineRole(staff, t, role);
    for (const p of people) {
      await host.admin.assignRole(staff, {
        principalId: p,
        roleKey: 'member',
        node: { tenantId: t, scopeId: s },
      });
    }
  }

  // The bootstrap grant: the space's owner holds write and manage on the ROOT
  // folder, and everything beneath it is reached through the declared parent edge —
  // file → folder → folder → root. Nobody else holds either one, anywhere.
  for (const [p, t, s] of [
    [ada, tenant, scope],
    [cleo, otherTenant, otherScope],
  ] as const) {
    for (const permission of [DRIVE_PERM.write, DRIVE_PERM.manage]) {
      await host.admin.grant(staff, {
        principalId: p,
        permission,
        node: { tenantId: t, scopeId: s },
        entity: { entityType: 'folder', entityId: ROOT_FOLDER_ID },
        grantedBy: p,
      });
    }
  }
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('a space is a scope', () => {
  let documents: string;
  let readme: string;

  it('the schema carries no space id — the conversion, in one assertion', () => {
    const sql = driveMigrations.map((m) => m.sql).join('\n');
    expect(sql).not.toMatch(/tenant_id|space_id/);
  });

  it('Ada creates a folder and writes a file into it', async () => {
    const stub = await host.getScope(ada, tenant, scope);

    const folder = await stub.invoke<FolderRow>('drive/create-folder', {
      parentId: ROOT_FOLDER_ID,
      name: 'Documents',
    });
    documents = folder.id;
    expect(folder.path).toBe('Documents');

    const file = await stub.invoke<FileRow>('drive/put-file', {
      folderId: documents,
      name: 'readme.md',
      mime: 'text/markdown',
      size: 12,
      location: { source: 'blob', blobRef: 'sha256:aaa' },
    });
    readme = file.id;
    expect(file.current_version_id).toBeTruthy();
  });

  it('writing the same name again supersedes: one file, two versions', async () => {
    const stub = await host.getScope(ada, tenant, scope);
    const again = await stub.invoke<FileRow>('drive/put-file', {
      folderId: documents,
      name: 'readme.md',
      mime: 'text/markdown',
      size: 20,
      location: { source: 'blob', blobRef: 'sha256:bbb' },
    });
    expect(again.id).toBe(readme);

    const versions = await stub.invoke<{ entries: { id: string; blob_ref: string | null }[] }>(
      'drive/file-versions',
      { fileId: readme },
    );
    expect(versions.entries).toHaveLength(2);
    expect(versions.entries[0]!.blob_ref).toBe('sha256:bbb'); // newest first
  });

  it('the folder listing is one hop, then a local query', async () => {
    const stub = await host.getScope(ada, tenant, scope);
    const page = await stub.invoke<{ entries: FileRow[] }>('drive/list-folder', {
      folderId: documents,
    });
    expect(page.entries.map((f) => f.name)).toEqual(['readme.md']);
  });

  it('a member reads the space drive, because membership is the grant', async () => {
    const stub = await host.getScope(bjorn, tenant, scope);
    const page = await stub.invoke<{ entries: FileRow[] }>('drive/list-folder', {
      folderId: documents,
    });
    expect(page.entries.map((f) => f.name)).toEqual(['readme.md']);
  });

  it('…and is refused the write nobody granted him', async () => {
    const stub = await host.getScope(bjorn, tenant, scope);
    await expect(
      stub.invoke('drive/put-file', {
        folderId: documents,
        name: 'notes.md',
        mime: 'text/markdown',
        size: 4,
        location: { source: 'blob', blobRef: 'sha256:ccc' },
      }),
    ).rejects.toThrow();
  });

  it('a name carrying a path separator is refused, not concatenated', async () => {
    const stub = await host.getScope(ada, tenant, scope);
    // Without this rule "A/B" under the root would occupy the path of a real B
    // inside A while carrying the root's parent edge — the permission hierarchy
    // and the path hierarchy disagreeing, which is what the edge exists to prevent.
    await expect(
      stub.invoke('drive/create-folder', { parentId: ROOT_FOLDER_ID, name: 'A/B' }),
    ).rejects.toThrow();
    await expect(
      stub.invoke('drive/put-file', {
        folderId: documents,
        name: '  ',
        mime: 'text/plain',
        size: 1,
        location: { source: 'blob', blobRef: 'sha256:ddd' },
      }),
    ).rejects.toThrow();
  });

  it("another tenant's scope shares no rows, not even the same paths", async () => {
    const stub = await host.getScope(cleo, otherTenant, otherScope);
    const folder = await stub.invoke<FolderRow>('drive/create-folder', {
      parentId: ROOT_FOLDER_ID,
      name: 'Documents',
    });
    const page = await stub.invoke<{ entries: FileRow[] }>('drive/list-folder', {
      folderId: folder.id,
    });
    expect(page.entries).toEqual([]);
  });
});
