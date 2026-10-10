/**
 * Reads that address files by name (#299): what a WebDAV client needs, because it has a
 * path and never an id. Refusals are covered by the conformance kit; this is about which
 * rows come back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { ROOT_FOLDER_ID, driveManifest, driveModule } from '../src/index.js';
import { ROLES } from '../src/provision.js';

let dir: string;
let host: ScopeHost;

const staff = platformActorId.parse(ulid());
const tenant = tenantId.parse(ulid());
const scope = scopeId.parse(ulid());
const ada = principalId.parse(ulid());
const bjorn = principalId.parse(ulid());

interface FileRow { id: string; name: string; current_version_id: string | null }
interface Entry extends FileRow { size: number | null; mime: string | null }

const as = (who: typeof ada) => host.getScope(who, tenant, scope);

async function write(folderId: string, name: string, text: string): Promise<FileRow> {
  const stub = await as(ada);
  const file = await stub.invoke<FileRow>('drive/ensure-file', { folderId, name });
  const attachment = await (await host.attachments(ada, tenant, scope)).upload({
    entity: { entityType: 'file', entityId: file.id },
    filename: name,
    contentType: 'text/plain',
    visibility: 'internal',
    body: new TextEncoder().encode(text),
  });
  return stub.invoke<FileRow>('drive/record-version', { fileId: file.id, location: { source: 'blob', blobRef: attachment.id } });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'canopy-drive-names-'));
  host = new SqliteScopeHost({ dir });
  host.registerModule(driveModule);
  await host.admin.createTenant(staff, { id: tenant, slug: 'names', name: 'Names' });
  await host.admin.grantEntitlement(staff, tenant, driveManifest.entitlementKey as string);
  await host.provisionScope(staff, { tenantId: tenant, scopeId: scope, vertical: 'drive' });
  await host.provisionBlobStore(staff, { tenantId: tenant, vertical: 'drive', binding: 'BLOBS' });
  await host.admin.activateScope(staff, tenant, scope);
  for (const role of ROLES) await host.admin.defineRole(staff, tenant, role);
  await host.admin.assignRole(staff, { principalId: ada, roleKey: 'owner', node: { tenantId: tenant, scopeId: scope } });
  await host.admin.assignRole(staff, { principalId: bjorn, roleKey: 'viewer', node: { tenantId: tenant, scopeId: scope } });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('drive/file-by-name', () => {
  it('returns the live file with its current version and whether the caller may write it', async () => {
    const written = await write(ROOT_FOLDER_ID, 'notes.txt', 'hello');
    const owner = await (await as(ada)).invoke<{ file: FileRow; version: { id: string; size: number }; canWrite: boolean }>(
      'drive/file-by-name', { folderId: ROOT_FOLDER_ID, name: 'notes.txt' },
    );
    expect(owner.file.id).toBe(written.id);
    expect(owner.version).toMatchObject({ id: written.current_version_id, size: 5 });
    expect(owner.canWrite).toBe(true);
    const viewer = await (await as(bjorn)).invoke<{ canWrite: boolean }>('drive/file-by-name', { folderId: ROOT_FOLDER_ID, name: 'notes.txt' });
    expect(viewer.canWrite).toBe(false);
  });

  it('answers null for a missing or trashed name', async () => {
    const stub = await as(ada);
    expect(await stub.invoke('drive/file-by-name', { folderId: ROOT_FOLDER_ID, name: 'absent.txt' })).toBeNull();
    const doomed = await write(ROOT_FOLDER_ID, 'doomed.txt', 'bye');
    await stub.invoke('drive/trash-file', { fileId: doomed.id });
    expect(await stub.invoke('drive/file-by-name', { folderId: ROOT_FOLDER_ID, name: 'doomed.txt' })).toBeNull();
  });

  it('refuses a name that is not one path segment', async () => {
    await expect((await as(ada)).invoke('drive/file-by-name', { folderId: ROOT_FOLDER_ID, name: '../notes.txt' })).rejects.toThrow();
  });
});

describe('drive/list-file-entries', () => {
  it('pages live files by name with their version size and type', async () => {
    const folder = (await (await as(ada)).invoke<{ id: string }>('drive/create-folder', { parentId: ROOT_FOLDER_ID, name: 'Paged' })).id;
    for (const name of ['c.txt', 'a.txt', 'b.txt']) await write(folder, name, name.repeat(2));
    const trashed = await write(folder, 'aa.txt', 'gone');
    await (await as(ada)).invoke('drive/trash-file', { fileId: trashed.id });
    await (await as(ada)).invoke('drive/ensure-file', { folderId: folder, name: 'empty.txt' });

    const viewer = await as(bjorn);
    const first = await viewer.invoke<{ entries: Entry[]; next: string | null }>('drive/list-file-entries', { folderId: folder, limit: 2 });
    expect(first.entries.map((row) => row.name)).toEqual(['a.txt', 'b.txt']);
    expect(first.entries[0]).toMatchObject({ size: 10, mime: 'text/plain' });
    expect(first.next).toBe('b.txt');
    const second = await viewer.invoke<{ entries: Entry[]; next: string | null }>('drive/list-file-entries', { folderId: folder, after: first.next, limit: 2 });
    expect(second.entries.map((row) => [row.name, row.size])).toEqual([['c.txt', 10], ['empty.txt', null]]);
    expect(second.next).toBeNull();
  });
});
