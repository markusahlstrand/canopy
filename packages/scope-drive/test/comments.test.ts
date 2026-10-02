import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { driveModule, driveManifest, DRIVE_PERM, ROOT_FOLDER_ID } from '../src/index.js';
import { ROLES } from '../src/provision.js';

let dir: string;
let host: ScopeHost;
let fileId: string;
const staff = platformActorId.parse(ulid());
const tenant = tenantId.parse(ulid());
const scope = scopeId.parse(ulid());
const ada = principalId.parse(ulid());
const bjorn = principalId.parse(ulid());
const outsider = principalId.parse(ulid());
const as = (who: typeof ada) => host.getScope(who, tenant, scope);
interface Comment { id: string; file_id: string; author: string; body: string; authorLabel: string; canDelete: boolean }
interface Thread { entries: Comment[]; nextCursor: string | null }

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'canopy-comments-'));
  host = new SqliteScopeHost({ dir });
  // Read-port fixtures: seed a pre-existing thread when this one file is created.
  // The production write operations land in the next slice; this wrapper stays in the test.
  host.registerModule({ ...driveModule, operations: { ...driveModule.operations,
    'drive/ensure-file': async (ctx, input: Record<string, unknown>) => {
      const file = await driveModule.operations!['drive/ensure-file']!(ctx, input as never) as { id: string };
      if (input.name === 'seeded.txt') {
        for (const [author, body, deleted] of [[ada, 'First', null], [bjorn, 'Second', null], [ada, 'Deleted', '2026-01-01']] as const) {
          const id = ulid();
          ctx.sql.exec('INSERT INTO drive_file_comments (id, file_id, author, body, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)', [id, file.id, author, body, ctx.now(), deleted]);
          ctx.link({ entityType: 'file_comment', entityId: id }, { entityType: 'file', entityId: file.id });
        }
      }
      return file;
    },
  } });
  await host.admin.createTenant(staff, { id: tenant, slug: `comments-${tenant.slice(-6).toLowerCase()}`, name: 'Comments' });
  await host.admin.grantEntitlement(staff, tenant, driveManifest.entitlementKey as string);
  await host.provisionScope(staff, { tenantId: tenant, scopeId: scope, vertical: 'drive' });
  await host.admin.activateScope(staff, tenant, scope);
  for (const role of ROLES) await host.admin.defineRole(staff, tenant, role);
  await host.admin.assignRole(staff, { principalId: ada, roleKey: 'owner', node: { tenantId: tenant, scopeId: scope } });
  await host.admin.assignRole(staff, { principalId: bjorn, roleKey: 'member', node: { tenantId: tenant, scopeId: scope } });
  const owner = await as(ada);
  await owner.invoke('drive/record-person', { principal: ada, name: 'Ada', email: 'ada@example.test' });
  fileId = (await owner.invoke<{ id: string }>('drive/ensure-file', { folderId: ROOT_FOLDER_ID, name: 'seeded.txt' })).id;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('scope-local comment reads', () => {
  it('reads an ordered thread, resolves author names and exposes moderation rights', async () => {
    const reader = await as(bjorn);
    const first = await reader.invoke<Thread>('drive/list-comments', { fileId, limit: 1 });
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]).toMatchObject({ body: 'First', authorLabel: 'Ada', canDelete: false });
    expect(first.nextCursor).not.toBeNull();
    const second = await reader.invoke<Thread>('drive/list-comments', { fileId, cursor: first.nextCursor, limit: 1 });
    expect(second.entries[0]).toMatchObject({ body: 'Second', authorLabel: bjorn, canDelete: true });
    expect(second.nextCursor).toBeNull();
    const owner = await (await as(ada)).invoke<Thread>('drive/list-comments', { fileId });
    expect(owner.entries.map(row => row.body)).toEqual(['First', 'Second']);
    expect(owner.entries.every(row => row.canDelete)).toBe(true);
  });

  it('refuses outsiders and missing files, and returns an empty thread for a new file', async () => {
    await expect((await as(outsider)).invoke('drive/list-comments', { fileId })).rejects.toThrow();
    await expect((await as(bjorn)).invoke('drive/list-comments', { fileId: 'missing' })).rejects.toThrow();
    const fresh = await (await as(ada)).invoke<{ id: string }>('drive/ensure-file', { folderId: ROOT_FOLDER_ID, name: 'empty-thread.txt' });
    expect(await (await as(bjorn)).invoke('drive/list-comments', { fileId: fresh.id })).toEqual({ entries: [], nextCursor: null });
  });

  it('hides a trashed file thread', async () => {
    const owner = await as(ada);
    const fresh = await owner.invoke<{ id: string }>('drive/ensure-file', { folderId: ROOT_FOLDER_ID, name: 'trashed-thread.txt' });
    await owner.invoke('drive/trash-file', { fileId: fresh.id });
    await expect((await as(bjorn)).invoke('drive/list-comments', { fileId: fresh.id })).rejects.toThrow('file not found');
  });
});
