import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId, type FileSourceChange } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { driveManifest, driveModule, DRIVE_PERM, ROOT_FOLDER_ID } from '../src/index.js';
import { ROLES } from '../src/provision.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function world() {
  const dir = mkdtempSync(join(tmpdir(), 'source-landing-')); dirs.push(dir);
  const host = new SqliteScopeHost({ dir }); host.registerModule(driveModule);
  const staff = platformActorId.parse(ulid()), t = tenantId.parse(ulid()), s = scopeId.parse(ulid());
  const owner = principalId.parse(ulid()), source = principalId.parse(ulid()), editor = principalId.parse(ulid());
  await host.admin.createTenant(staff, { id: t, slug: 'source', name: 'Source' });
  await host.admin.grantEntitlement(staff, t, driveManifest.entitlementKey as string);
  await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'drive' });
  await host.admin.activateScope(staff, t, s);
  await host.provisionBlobStore(staff, { tenantId: t, vertical: 'drive', binding: 'BLOBS' });
  for (const role of ROLES) await host.admin.defineRole(staff, t, role);
  for (const p of [owner, source]) await host.admin.assignRole(staff, { principalId: p, roleKey: 'owner', node: { tenantId: t, scopeId: s } });
  await host.admin.assignRole(staff, { principalId: editor, roleKey: 'editor', node: { tenantId: t, scopeId: s } });
  await host.admin.grant(staff, { principalId: source, permission: DRIVE_PERM.landSource, node: { tenantId: t, scopeId: s }, grantedBy: source });
  const stub = await host.getScope(source, t, s), human = await host.getScope(owner, t, s), member = await host.getScope(editor, t, s);
  const land = <O = { entity: { entityType: string; entityId: string } }>(input: FileSourceChange) => stub.invoke<O>('drive/land-source-change', input);
  const bytes = await host.attachments(source, t, s);
  const connect = (canUpload = true, connectionId = 'connection', provider = 'canopy.a3doc') =>
    human.invoke('drive/record-source', { provider, connectionId, account: 'ACME', folder: 'Facturas', canUpload });
  const upsert = (itemId: string, path: string, kind: 'file' | 'folder' = 'file') => ({
    connectionId: 'connection', itemId, kind, path, name: path.split('/').at(-1)!, change: 'upsert' as const,
    previousPath: null, size: 5, contentType: 'text/plain', lastModifiedAt: null, webUrl: null, content: kind === 'file' ? 'follows' as const : null,
  });
  /** How many events of `type` the scope has emitted. */
  const emitted = async (type: string) => (await host.admin.queryScope(staff, t, s, { sql: `SELECT COUNT(*) FROM _substrat_outbox WHERE type = '${type}'` })).rows[0]![0];
  return { land, upsert, bytes, stub, human, member, connect, emitted };
}

it('keeps item and version identity on redelivery and appends changed content', async () => {
  const w = await world();
  const input = w.upsert('doc@1', 'Invoice.txt');
  const first = await w.land(input);
  expect(await w.land(input)).toEqual(first);
  const attachment = await w.bytes.upload({ entity: first.entity, filename: input.name, contentType: 'text/plain', visibility: 'internal', body: new TextEncoder().encode('first') });
  const content = { ...input, change: 'content' as const, attachment, replaces: null };
  await w.land(content);
  const get = () => w.stub.invoke<{ file: { id: string; current_version_id: string }; version: { blob_ref: string } }>('drive/get-file', { fileId: first.entity.entityId });
  const one = await get();
  await w.land(content);
  expect(await get()).toEqual(one);
  const second = await w.bytes.upload({ entity: first.entity, filename: input.name, contentType: 'text/plain', visibility: 'internal', body: new TextEncoder().encode('second') });
  await w.land({ ...content, attachment: second, replaces: attachment.id });
  expect((await get()).version.blob_ref).toBe(second.id);
  expect((await get()).file.current_version_id).not.toBe(one.file.current_version_id);
  await expect(w.land({ ...content, replaces: null })).rejects.toThrow('stale source content');
  await w.land({ ...input, path: 'Renamed.txt', name: 'Renamed.txt', content: 'unchanged', previousPath: input.path });
  expect((await get()).file.id).toBe(first.entity.entityId);
});

it('deletes only the named item, frees its name, and restores its identity', async () => {
  const w = await world();
  const folder = await w.land(w.upsert('folder', 'Invoices', 'folder'));
  const input = w.upsert('first', 'Invoices/Tax.txt');
  const first = await w.land(input);
  const sibling = await w.land(w.upsert('second', 'Invoices/Other.txt'));
  const del = { ...input, change: 'delete' as const, reason: 'deleted' as const };
  await w.land(del); await w.land(del);
  const replacement = await w.land(w.upsert('third', 'Invoices/Tax.txt'));
  expect(replacement.entity.entityId).not.toBe(first.entity.entityId);
  await w.land({ ...w.upsert('folder', 'Invoices', 'folder'), change: 'delete', reason: 'moved-out' });
  expect(await w.stub.invoke('drive/get-file', { fileId: sibling.entity.entityId })).toBeTruthy();
  expect(await w.stub.invoke('drive/get-folder', { folderId: folder.entity.entityId })).toBeTruthy();
  await w.land({ ...w.upsert('third', 'Invoices/Tax.txt'), change: 'delete', reason: 'deleted' });
  expect(await w.land(input)).toEqual(first);
});

it('refuses landing by an ordinary owner and rejects path traversal and foreign attachments', async () => {
  const w = await world();
  await expect(w.human.invoke('drive/land-source-change', w.upsert('doc', 'Tax.txt'))).rejects.toThrow();
  await expect(w.land(w.upsert('doc', '../Tax.txt'))).rejects.toThrow('valid segments');
  const a = await w.land(w.upsert('a', 'A.txt'));
  await w.land(w.upsert('b', 'B.txt'));
  const attachment = await w.bytes.upload({ entity: a.entity, filename: 'A.txt', contentType: 'text/plain', visibility: 'internal', body: new Uint8Array([1]) });
  await expect(w.land({ ...w.upsert('b', 'B.txt'), change: 'content', attachment, replaces: null })).rejects.toThrow('another file');
});


it('adopts the upload echo without duplicating the local file or its version', async () => {
  const w = await world();
  const file = await w.stub.invoke<{ id: string }>('drive/ensure-file', { folderId: 'root', name: 'Upload.txt' });
  const attachment = await w.bytes.upload({ entity: { entityType: 'file', entityId: file.id }, filename: 'Upload.txt', contentType: 'text/plain', visibility: 'internal', body: new TextEncoder().encode('upload') });
  await w.stub.invoke('drive/record-version', { fileId: file.id, location: { source: 'blob', blobRef: attachment.id } });
  const first = await w.stub.invoke<{file: {current_version_id: string}}>('drive/get-file', {fileId: file.id});
  await w.connect();
  await w.stub.invoke('drive/send-source-file', { fileId: file.id });
  const echoed = await w.land(w.upsert('uploaded-doc', 'Upload.txt'));
  expect(echoed.entity.entityId).toBe(file.id);
  const copy = await w.bytes.upload({ entity: echoed.entity, filename: 'Upload.txt', contentType: 'text/plain', visibility: 'internal', body: new TextEncoder().encode('upload') });
  await w.land({ ...w.upsert('uploaded-doc', 'Upload.txt'), change: 'content', attachment: copy, replaces: null });
  const after = await w.stub.invoke<{file: {current_version_id: string}}>('drive/get-file', {fileId: file.id});
  expect(after.file.current_version_id).toBe(first.file.current_version_id);
});

it('moves a renamed folder\'s descendants and leaves look-alike siblings alone', async () => {
  const w = await world();
  const top = await w.land(w.upsert('top', 'Año 🧾_%', 'folder'));
  const child = await w.land(w.upsert('child', 'Año 🧾_%/Q1', 'folder'));
  const deep = await w.land(w.upsert('deep', 'Año 🧾_%/Q1/Ene', 'folder'));
  const sibling = await w.land(w.upsert('sibling', 'Año 🧾_%x', 'folder'));
  await w.land({ ...w.upsert('top', '2026', 'folder'), previousPath: 'Año 🧾_%' });
  const pathOf = async (folderId: string) => (await w.stub.invoke<{ path: string }>('drive/get-folder', { folderId })).path;
  expect(await pathOf(top.entity.entityId)).toBe('2026');
  expect(await pathOf(child.entity.entityId)).toBe('2026/Q1');
  expect(await pathOf(deep.entity.entityId)).toBe('2026/Q1/Ene');
  expect(await pathOf(sibling.entity.entityId)).toBe('Año 🧾_%x');
});

it('sends a connected upload once and refuses to replace it', async () => {
  const w = await world();
  const file = await w.stub.invoke<{ id: string }>('drive/ensure-file', { folderId: 'root', name: 'Draft.txt' });
  const entity = { entityType: 'file', entityId: file.id };
  const upload = (text: string) => w.bytes.upload({ entity, filename: 'Draft.txt', contentType: 'text/plain', visibility: 'internal', body: new TextEncoder().encode(text) });
  const one = await upload('one');
  await w.stub.invoke('drive/record-version', { fileId: file.id, location: { source: 'blob', blobRef: one.id } });
  await expect(w.stub.invoke('drive/send-source-file', { fileId: file.id })).rejects.toThrow('not connected');
  await w.connect();
  await w.stub.invoke('drive/send-source-file', { fileId: file.id });
  await w.stub.invoke('drive/send-source-file', { fileId: file.id });
  const two = await upload('two');
  await expect(w.stub.invoke('drive/record-version', { fileId: file.id, location: { source: 'blob', blobRef: two.id } })).rejects.toThrow("can't replace a document");
});

it('refuses tree changes in a connected space and uploads its a3doc user may not make', async () => {
  const w = await world();
  const folder = await w.stub.invoke<{ id: string }>('drive/create-folder', { parentId: 'root', name: 'Local' });
  const file = await w.stub.invoke<{ id: string }>('drive/ensure-file', { folderId: 'root', name: 'Local.txt' });
  await w.connect(false);
  expect((await w.human.invoke<{ source: { canUpload: boolean } }>('drive/get-source')).source.canUpload).toBe(false);
  const refused = [
    ['drive/create-folder', { parentId: 'root', name: 'New' }, 'create folders'],
    ['drive/rename-folder', { folderId: folder.id, name: 'Renamed' }, 'rename folders'],
    ['drive/move-folder', { folderId: folder.id, parentId: 'root' }, 'move folders'],
    ['drive/rename-file', { fileId: file.id, name: 'Renamed.txt' }, 'rename documents'],
    ['drive/move-file', { fileId: file.id, folderId: folder.id }, 'move documents'],
    ['drive/trash-file', { fileId: file.id }, 'delete documents'],
    ['drive/ensure-file', { folderId: 'root', name: 'Upload.txt' }, "can't upload"],
  ] as const;
  for (const [operation, input, reason] of refused) await expect(w.human.invoke(operation, input), operation).rejects.toThrow(reason);
  // The existing file is still found by name, so an upload of the same name reaches the replace refusal.
  expect((await w.human.invoke<{ id: string }>('drive/ensure-file', { folderId: 'root', name: 'Local.txt' })).id).toBe(file.id);
  await w.human.invoke('drive/clear-source');
  expect(await w.human.invoke('drive/get-source')).toEqual({ source: null });
  await w.human.invoke('drive/rename-file', { fileId: file.id, name: 'Renamed.txt' });
});

it('keeps identities for the same connection and releases them for another', async () => {
  const w = await world();
  await w.connect();
  const first = await w.land(w.upsert('doc', 'Tax.txt'));
  await w.human.invoke('drive/clear-source');
  await w.connect();
  expect(await w.land(w.upsert('doc', 'Tax.txt'))).toEqual(first);
  await w.connect(true, 'other-connection');
  // The old file is an ordinary file now, so the new account's document of that name cannot take it over.
  await expect(w.land({ ...w.upsert('doc', 'Tax.txt'), connectionId: 'other-connection' })).rejects.toThrow('occupied');
  expect(await w.stub.invoke('drive/get-file', { fileId: first.entity.entityId })).toBeTruthy();
});

it('lets only a manager connect a space, and any member read what it is connected to', async () => {
  const w = await world();
  expect(await w.human.invoke('drive/source-access')).toMatchObject({ source: null });
  for (const operation of ['drive/source-access', 'drive/clear-source'] as const) await expect(w.member.invoke(operation), operation).rejects.toThrow();
  await expect(w.member.invoke('drive/record-source', { provider: 'canopy.a3doc', connectionId: 'c', account: 'A', folder: '', canUpload: true })).rejects.toThrow();
  await w.connect();
  expect(await w.member.invoke('drive/get-source')).toMatchObject({ source: { account: 'ACME', folder: 'Facturas', canUpload: true } });
});

it('adopts a folder made here when the source reports it, but never one another item holds', async () => {
  const w = await world();
  const made = await w.human.invoke<{ id: string }>('drive/create-folder', { parentId: ROOT_FOLDER_ID, name: 'Made here' });
  const landed = await w.land(w.upsert('made-here/', 'Made here', 'folder'));
  expect(landed.entity.entityId).toBe(made.id);
  expect(await w.land(w.upsert('made-here/', 'Made here', 'folder'))).toEqual(landed);
  await expect(w.land(w.upsert('other/', 'Made here', 'folder'))).rejects.toThrow('source folder path is occupied');
});

it('sends a file to the bucket, follows its newest version, and adopts the echo of its own attachment', async () => {
  const w = await world();
  await w.connect(true, 'connection', 'canopy.s3');
  const file = await w.stub.invoke<{ id: string }>('drive/ensure-file', { folderId: 'root', name: 'Scan.txt' });
  const entity = { entityType: 'file', entityId: file.id };
  const upload = (text: string) => w.bytes.upload({ entity, filename: 'Scan.txt', contentType: 'text/plain', visibility: 'internal', body: new TextEncoder().encode(text) });
  const one = await upload('one');
  await w.stub.invoke('drive/record-version', { fileId: file.id, location: { source: 'blob', blobRef: one.id } });
  expect(await w.stub.invoke('drive/send-s3-file', { fileId: file.id })).toMatchObject({ directory: '', conflict: 'replace', files: [{ attachmentId: one.id, name: 'Scan.txt' }] });
  const two = await upload('two');
  await w.stub.invoke('drive/record-version', { fileId: file.id, location: { source: 'blob', blobRef: two.id } });
  expect(await w.stub.invoke('drive/send-s3-file', { fileId: file.id })).toMatchObject({ files: [{ attachmentId: two.id }] });
  const before = await w.stub.invoke<{ file: { current_version_id: string } }>('drive/get-file', { fileId: file.id });
  // The connector lands the drive's own attachment as the content: no new version.
  const echoed = await w.land(w.upsert('Scan.txt', 'Scan.txt'));
  expect(echoed.entity.entityId).toBe(file.id);
  await w.land({ ...w.upsert('Scan.txt', 'Scan.txt'), change: 'content', attachment: two, replaces: two.id });
  const after = await w.stub.invoke<{ file: { current_version_id: string } }>('drive/get-file', { fileId: file.id });
  expect(after.file.current_version_id).toBe(before.file.current_version_id);
});

it('bounds an S3 change request by the folder it was made in', async () => {
  const w = await world();
  const box = await w.human.invoke<{ id: string }>('drive/create-folder', { parentId: ROOT_FOLDER_ID, name: 'Box' });
  const move0 = { op: 'move', kind: 'file', from: 'Box/a.txt', to: 'Box/b.txt' };
  await expect(w.human.invoke('drive/request-s3-change', { folderId: box.id, request: move0 })).rejects.toThrow('not connected to S3 bucket');
  await w.connect(true, 'connection', 'canopy.s3');
  await expect(w.human.invoke('drive/create-folder', { parentId: ROOT_FOLDER_ID, name: 'Later' })).rejects.toThrow("the drive can't create folders in it yet");
  const move = { op: 'move', kind: 'file', from: 'Box/a.txt', to: 'Box/b.txt' };
  expect(await w.human.invoke('drive/request-s3-change', { folderId: box.id, request: move })).toMatchObject({ id: box.id, request: move });
  await expect(w.human.invoke('drive/request-s3-change', { folderId: box.id, request: { ...move, to: 'Elsewhere/b.txt' } })).rejects.toThrow('outside the folder');
  await expect(w.human.invoke('drive/request-s3-change', { folderId: box.id, request: { op: 'delete', items: [{ kind: 'folder', path: 'Boxed' }] } })).rejects.toThrow('outside the folder');
  expect(await w.human.invoke('drive/request-s3-change', { folderId: ROOT_FOLDER_ID, request: { op: 'mkdir', path: 'Anywhere' } })).toMatchObject({ id: ROOT_FOLDER_ID });
  // A move onto a path the space already holds would wedge the sync: refused before it leaves.
  await expect(w.human.invoke('drive/request-s3-change', { folderId: ROOT_FOLDER_ID, request: { op: 'move', kind: 'folder', from: 'Other', to: 'Box' } })).rejects.toThrow("'Box' already exists in this space");
});

it('resends to the bucket after a send that failed for good, without a new version', async () => {
  const w = await world();
  await w.connect(true, 'connection', 'canopy.s3');
  const file = await w.stub.invoke<{ id: string }>('drive/ensure-file', { folderId: 'root', name: 'Taken.txt' });
  const one = await w.bytes.upload({ entity: { entityType: 'file', entityId: file.id }, filename: 'Taken.txt', contentType: 'text/plain', visibility: 'internal', body: new TextEncoder().encode('one') });
  await w.stub.invoke('drive/record-version', { fileId: file.id, location: { source: 'blob', blobRef: one.id } });
  await w.stub.invoke('drive/send-s3-file', { fileId: file.id, conflict: 'fail' });
  // Say the connector refused that one ('fail' found the name taken): the same version goes again.
  expect(await w.stub.invoke('drive/send-s3-file', { fileId: file.id, conflict: 'replace' })).toMatchObject({ conflict: 'replace', files: [{ attachmentId: one.id }] });
  expect(await w.emitted('s3.files-requested')).toBe(2);
});
