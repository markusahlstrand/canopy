/** The file mirror resumes from the kernel's event ids, never a second sequence table. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { DRIVE_PERM, ROOT_FOLDER_ID, driveManifest, driveModule } from '../src/index.js';
import { ROLES } from '../src/provision.js';

type Change = { id: string; type: string; fileId: string; file: { id: string; name: string } | null };
type Feed = { changes: Change[]; cursor: string | null; hasMore: boolean };

let dir: string;
let host: ScopeHost;
const staff = platformActorId.parse(ulid());
const tenant = tenantId.parse(ulid());
const scope = scopeId.parse(ulid());
const ada = principalId.parse(ulid());
const bjorn = principalId.parse(ulid());
const outsider = principalId.parse(ulid());

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'canopy-drive-changes-'));
  host = new SqliteScopeHost({ dir });
  host.registerModule(driveModule);
  await host.admin.createTenant(staff, { id: tenant, slug: 'changes', name: 'Changes' });
  await host.admin.grantEntitlement(staff, tenant, driveManifest.entitlementKey as string);
  await host.provisionScope(staff, { tenantId: tenant, scopeId: scope, vertical: 'drive' });
  await host.admin.activateScope(staff, tenant, scope);
  for (const role of ROLES) await host.admin.defineRole(staff, tenant, role);
  for (const principalId of [ada, bjorn]) {
    await host.admin.assignRole(staff, {
      principalId, roleKey: 'member', node: { tenantId: tenant, scopeId: scope },
    });
  }
  await host.admin.grant(staff, {
    principalId: ada,
    permission: DRIVE_PERM.write,
    node: { tenantId: tenant, scopeId: scope },
    entity: { entityType: 'folder', entityId: ROOT_FOLDER_ID },
    grantedBy: ada,
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('file changes over the scope spine', () => {
  it('pages by event id, hydrates current metadata, and emits a trash tombstone', async () => {
    const writer = await host.getScope(ada, tenant, scope);
    const reader = await host.getScope(bjorn, tenant, scope);
    expect((await reader.invoke<Feed>('drive/changes', {})).changes).toEqual([]);

    const created = await writer.invoke<{ id: string }>('drive/ensure-file', {
      folderId: ROOT_FOLDER_ID, name: 'first.txt',
    });
    await writer.invoke('drive/rename-file', { fileId: created.id, name: 'final.txt' });

    const first = await reader.invoke<Feed>('drive/changes', { limit: 1 });
    expect(first.hasMore).toBe(true);
    expect(first.changes).toHaveLength(1);
    expect(first.changes[0]).toMatchObject({
      type: 'drive.file-created', fileId: created.id, file: { name: 'final.txt' },
    });
    const second = await reader.invoke<Feed>('drive/changes', { after: first.cursor, limit: 1 });
    expect(second.hasMore).toBe(false);
    expect(second.changes).toHaveLength(1);
    expect(second.changes[0]).toMatchObject({
      type: 'drive.file-renamed', fileId: created.id, file: { name: 'final.txt' },
    });
    expect(second.cursor! > first.cursor!).toBe(true);

    await writer.invoke('drive/trash-file', { fileId: created.id });
    const trashed = await reader.invoke<Feed>('drive/changes', { after: second.cursor });
    expect(trashed.changes).toMatchObject([{
      type: 'drive.file-trashed', fileId: created.id, file: null,
    }]);

    await writer.invoke('drive/restore-file', { fileId: created.id });
    const restored = await reader.invoke<Feed>('drive/changes', { after: trashed.cursor });
    expect(restored.changes).toMatchObject([{
      type: 'drive.file-restored', fileId: created.id, file: { name: 'final.txt' },
    }]);
    expect((await reader.invoke<Feed>('drive/changes', { after: restored.cursor })).changes).toEqual([]);
  });

  it('refuses a caller without scope read before touching the spine', async () => {
    await expect(
      host.getScope(outsider, tenant, scope).then((stub) => stub.invoke('drive/changes', {})),
    ).rejects.toThrow();
  });
});
