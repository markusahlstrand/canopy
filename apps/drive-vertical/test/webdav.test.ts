/// <reference types="node" />
/**
 * WebDAV against real scopes (#299): the protocol layer in `webdav.ts` over a
 * `SqliteScopeHost`, so every permission decision and every stored byte is the kernel's.
 * Only the app-password → login step is faked; its storage is tested in
 * `test/app-passwords.test.ts`, and the worker's real wiring in `e2e/webdav.spec.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId, type PrincipalId, type ScopeId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { ROOT_FOLDER_ID, driveManifest, driveModule } from '@canopy/scope-drive';
import { ROLES } from '@canopy/scope-drive/provision';
import { mountWebdav, type DavSpace } from '../src/webdav';

let dir: string;
let host: SqliteScopeHost;
const staff = platformActorId.parse(ulid());
const tenant = tenantId.parse(ulid());
const owner = principalId.parse(ulid());
const viewer = principalId.parse(ulid());

interface Space { slug: string; name: string; id: ScopeId; members: Map<PrincipalId, string> }
const spaces: Space[] = [];
/** Which login each password signs in as. */
const passwords = new Map<string, PrincipalId>([['owner-secret', owner], ['viewer-secret', viewer]]);
const writes: string[] = [];

async function addSpace(slug: string, name: string, members: [PrincipalId, string][]): Promise<Space> {
  const id = scopeId.parse(ulid());
  await host.provisionScope(staff, { tenantId: tenant, scopeId: id, vertical: 'drive' });
  await host.admin.activateScope(staff, tenant, id);
  for (const [who, role] of members) await host.admin.assignRole(staff, { principalId: who, roleKey: role, node: { tenantId: tenant, scopeId: id } });
  const space = { slug, name, id, members: new Map(members) };
  spaces.push(space);
  return space;
}

function davSpaces(who: PrincipalId): Promise<DavSpace[]> {
  return Promise.all(spaces.filter((s) => s.members.has(who)).map(async (s) => {
    const stub = await host.getScope(who, tenant, s.id);
    const attachments = () => host.attachments(who, tenant, s.id);
    return {
      slug: s.slug,
      name: s.name,
      scope: {
        invoke: <T,>(operation: string, input: Record<string, unknown>) => stub.invoke<T>(operation, input),
        upload: async (fileId: string, name: string, mime: string, body: Uint8Array) =>
          (await (await attachments()).upload({ entity: { entityType: 'file', entityId: fileId }, filename: name, contentType: mime, visibility: 'internal', body })).id,
        open: async (ref: string) => (await attachments()).open(ref),
        afterWrite: async (file: { name: string }) => { writes.push(file.name); },
      },
    };
  }));
}

const app = new Hono();
mountWebdav(app, async (_c, password) => {
  const who = passwords.get(password);
  return who ? davSpaces(who) : null;
});

const auth = (password: string) => ({ Authorization: `Basic ${btoa(`anyone:${password}`)}` });
const dav = (password: string, path: string, method: string, init: { body?: string; headers?: Record<string, string> } = {}) =>
  app.request(`https://canopy.test${path}`, { method, body: init.body, headers: { ...auth(password), ...init.headers } });
const hrefs = async (response: Response) => [...(await response.text()).matchAll(/<D:href>([^<]+)<\/D:href>/g)].map((m) => decodeURIComponent(m[1]!));

let family: Space;
let work: Space;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'canopy-webdav-'));
  host = new SqliteScopeHost({ dir });
  host.registerModule(driveModule);
  await host.admin.createTenant(staff, { id: tenant, slug: 'webdav', name: 'WebDAV' });
  await host.admin.grantEntitlement(staff, tenant, driveManifest.entitlementKey as string);
  await host.provisionBlobStore(staff, { tenantId: tenant, vertical: 'drive', binding: 'BLOBS' });
  for (const role of ROLES) await host.admin.defineRole(staff, tenant, role);
  family = await addSpace('family-1', 'Family', [[owner, 'owner'], [viewer, 'viewer']]);
  work = await addSpace('work-1', 'Work', [[owner, 'owner']]);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('authentication', () => {
  it('asks for Basic credentials and refuses an unknown password', async () => {
    const anonymous = await app.request('https://canopy.test/dav/', { method: 'PROPFIND' });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toMatch(/^Basic realm="Canopy"/);
    expect((await dav('wrong', '/dav/', 'PROPFIND')).status).toBe(401);
  });

  it('answers OPTIONS without credentials, advertising class 2', async () => {
    const options = await app.request('https://canopy.test/dav/', { method: 'OPTIONS' });
    expect(options.headers.get('DAV')).toBe('1, 2');
    expect(options.headers.get('Allow')).toContain('PROPFIND');
  });
});

describe('an owner works in a space', () => {
  it('lists only the spaces the login can enter', async () => {
    expect(await hrefs(await dav('owner-secret', '/dav/', 'PROPFIND'))).toEqual(['/dav/', '/dav/Family/', '/dav/Work/']);
    expect(await hrefs(await dav('viewer-secret', '/dav/', 'PROPFIND'))).toEqual(['/dav/', '/dav/Family/']);
    expect(await hrefs(await dav('owner-secret', '/dav/', 'PROPFIND', { headers: { Depth: '0' } }))).toEqual(['/dav/']);
  });

  it('creates folders, writes and reads files, and keeps each write as a version', async () => {
    expect((await dav('owner-secret', '/dav/Family/Papers/', 'MKCOL')).status).toBe(201);
    expect((await dav('owner-secret', '/dav/Family/Papers/', 'MKCOL')).status).toBe(405);
    expect((await dav('owner-secret', '/dav/Family/Missing/Deeper/', 'MKCOL')).status).toBe(409);
    expect((await dav('owner-secret', '/dav/Family/Papers/lease.txt', 'PUT', { body: 'first' })).status).toBe(201);
    expect((await dav('owner-secret', '/dav/Family/Papers/lease.txt', 'PUT', { body: 'second draft' })).status).toBe(204);
    const read = await dav('owner-secret', '/dav/Family/Papers/lease.txt', 'GET');
    expect(await read.text()).toBe('second draft');
    expect(read.headers.get('content-type')).toBe('text/plain');
    const listing = await dav('owner-secret', '/dav/Family/Papers/', 'PROPFIND');
    expect(listing.status).toBe(207);
    const body = await listing.text();
    expect(body).toContain('<D:href>/dav/Family/Papers/lease.txt</D:href>');
    expect(body).toContain('<D:getcontentlength>12</D:getcontentlength>');
    const stub = await host.getScope(owner, tenant, family.id);
    const folder = await stub.invoke<{ id: string }>('drive/folder-by-path', { path: 'Papers' });
    const found = await stub.invoke<{ file: { id: string } }>('drive/file-by-name', { folderId: folder.id, name: 'lease.txt' });
    const versions = await stub.invoke<{ entries: unknown[] }>('drive/file-versions', { fileId: found.file.id });
    expect(versions.entries).toHaveLength(2);
    expect(writes).toContain('lease.txt');
    expect((await dav('owner-secret', '/dav/Family/Nowhere/x.txt', 'PUT', { body: 'x' })).status).toBe(409);
  });

  it('serves uploaded pages sandboxed and as downloads, never as the app', async () => {
    await dav('owner-secret', '/dav/Family/page.html', 'PUT', { body: '<script>alert(1)</script>', headers: { 'content-type': 'text/html' } });
    const page = await dav('owner-secret', '/dav/Family/page.html', 'GET');
    expect(page.headers.get('content-type')).toBe('text/html');
    expect(page.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    expect(page.headers.get('content-disposition')).toMatch(/^attachment;/);
    const plain = await dav('owner-secret', '/dav/Family/Papers/lease.txt', 'GET');
    expect(plain.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    expect(plain.headers.get('content-disposition')).toBeNull();
  });

  it('accepts and discards macOS metadata files', async () => {
    expect((await dav('owner-secret', '/dav/Family/Papers/._lease.txt', 'PUT', { body: 'junk' })).status).toBe(201);
    expect((await dav('owner-secret', '/dav/Family/.DS_Store', 'PUT', { body: 'junk' })).status).toBe(201);
    expect(await hrefs(await dav('owner-secret', '/dav/Family/Papers/', 'PROPFIND'))).not.toContain('/dav/Family/Papers/._lease.txt');
  });

  it('renames and moves files and folders, and overwrites by writing a new version', async () => {
    await dav('owner-secret', '/dav/Family/draft.txt', 'PUT', { body: 'draft' });
    const rename = await dav('owner-secret', '/dav/Family/draft.txt', 'MOVE', { headers: { Destination: 'https://canopy.test/dav/Family/final.txt' } });
    expect(rename.status).toBe(201);
    const move = await dav('owner-secret', '/dav/Family/final.txt', 'MOVE', { headers: { Destination: '/dav/Family/Papers/moved.txt' } });
    expect(move.status).toBe(201);
    expect(await (await dav('owner-secret', '/dav/Family/Papers/moved.txt', 'GET')).text()).toBe('draft');
    expect((await dav('owner-secret', '/dav/Family/final.txt', 'GET')).status).toBe(404);

    // Save-by-rename: a temporary file replaces the original as its next version.
    await dav('owner-secret', '/dav/Family/Papers/.~tmp', 'PUT', { body: 'replaced' });
    const keep = await dav('owner-secret', '/dav/Family/Papers/.~tmp', 'MOVE', { headers: { Destination: '/dav/Family/Papers/moved.txt', Overwrite: 'F' } });
    expect(keep.status).toBe(412);
    const replace = await dav('owner-secret', '/dav/Family/Papers/.~tmp', 'MOVE', { headers: { Destination: '/dav/Family/Papers/moved.txt' } });
    expect(replace.status).toBe(204);
    expect(await (await dav('owner-secret', '/dav/Family/Papers/moved.txt', 'GET')).text()).toBe('replaced');

    await dav('owner-secret', '/dav/Family/Inbox/', 'MKCOL');
    const folder = await dav('owner-secret', '/dav/Family/Inbox/', 'MOVE', { headers: { Destination: '/dav/Family/Papers/Archive/' } });
    expect(folder.status).toBe(201);
    expect((await dav('owner-secret', '/dav/Family/Papers/Archive/', 'PROPFIND', { headers: { Depth: '0' } })).status).toBe(207);
  });

  it('copies files, also into another space, but not folders', async () => {
    const copy = await dav('owner-secret', '/dav/Family/Papers/lease.txt', 'COPY', { headers: { Destination: '/dav/Work/lease-copy.txt' } });
    expect(copy.status).toBe(201);
    expect(await (await dav('owner-secret', '/dav/Work/lease-copy.txt', 'GET')).text()).toBe('second draft');
    expect(await (await dav('owner-secret', '/dav/Family/Papers/lease.txt', 'GET')).text()).toBe('second draft');
    expect((await dav('owner-secret', '/dav/Family/Papers/', 'COPY', { headers: { Destination: '/dav/Work/Papers/' } })).status).toBe(403);
  });

  it('refuses moves across spaces and folder deletes, explicitly', async () => {
    const across = await dav('owner-secret', '/dav/Family/Papers/lease.txt', 'MOVE', { headers: { Destination: '/dav/Work/lease.txt' } });
    expect(across.status).toBe(403);
    expect(await across.text()).toMatch(/between spaces/);
    const folder = await dav('owner-secret', '/dav/Family/Papers/', 'DELETE');
    expect(folder.status).toBe(403);
    expect((await dav('owner-secret', '/dav/Family/', 'DELETE')).status).toBe(403);
  });

  it('moves a deleted file to Trash and will not reuse its name', async () => {
    await dav('owner-secret', '/dav/Work/old.txt', 'PUT', { body: 'old' });
    expect((await dav('owner-secret', '/dav/Work/old.txt', 'DELETE')).status).toBe(204);
    expect((await dav('owner-secret', '/dav/Work/old.txt', 'GET')).status).toBe(404);
    const trash = await (await host.getScope(owner, tenant, work.id)).invoke<{ name: string }[] | { entries: { name: string }[] }>('drive/list-trash', {});
    expect(JSON.stringify(trash)).toContain('old.txt');
    const reuse = await dav('owner-secret', '/dav/Work/old.txt', 'PUT', { body: 'new' });
    expect(reuse.status).toBe(409);
    expect(await reuse.text()).toMatch(/in Trash/);
  });

  it('refuses dot segments and encoded separators instead of normalizing them', async () => {
    expect((await dav('owner-secret', '/dav/Family/Papers/..%2F..%2FWork%2Flease-copy.txt', 'GET')).status).toBe(404);
    expect((await dav('owner-secret', '/dav/Family/Papers/%2E%2E/lease.txt', 'GET')).status).toBe(404);
  });
});

describe('a viewer', () => {
  it('reads but cannot write', async () => {
    expect(await (await dav('viewer-secret', '/dav/Family/Papers/lease.txt', 'GET')).text()).toBe('second draft');
    expect((await dav('viewer-secret', '/dav/Family/Papers/lease.txt', 'PUT', { body: 'no' })).status).toBe(403);
    expect((await dav('viewer-secret', '/dav/Family/Papers/new.txt', 'PUT', { body: 'no' })).status).toBe(403);
    expect((await dav('viewer-secret', '/dav/Family/Viewer/', 'MKCOL')).status).toBe(403);
    expect((await dav('viewer-secret', '/dav/Family/Papers/lease.txt', 'DELETE')).status).toBe(403);
    expect((await dav('viewer-secret', '/dav/Work/', 'PROPFIND')).status).toBe(404);
  });
});

describe('Shared with me', () => {
  it('mounts a directly granted folder, writes inside it only, and forgets it when revoked', async () => {
    expect(await hrefs(await dav('viewer-secret', '/dav/', 'PROPFIND'))).not.toContain('/dav/Shared with me/');
    const stub = await host.getScope(owner, tenant, family.id);
    const papers = await stub.invoke<{ id: string }>('drive/folder-by-path', { path: 'Papers' });
    await stub.invoke('drive/share-folder', { folderId: papers.id, principal: viewer, permission: 'drive:write' });

    expect(await hrefs(await dav('viewer-secret', '/dav/', 'PROPFIND'))).toContain('/dav/Shared with me/');
    const mounts = (await hrefs(await dav('viewer-secret', '/dav/Shared%20with%20me/', 'PROPFIND'))).slice(1);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatch(/^\/dav\/Shared with me\/Papers — Family \[[0-9a-f]{12}\]\/$/);
    const mount = mounts[0]!.split('/').map(encodeURIComponent).join('/').replace(/%2F/g, '/');

    expect(await (await dav('viewer-secret', `${mount}lease.txt`, 'GET')).text()).toBe('second draft');
    expect((await dav('viewer-secret', `${mount}from-viewer.txt`, 'PUT', { body: 'shared write' })).status).toBe(201);
    expect(await (await dav('owner-secret', '/dav/Family/Papers/from-viewer.txt', 'GET')).text()).toBe('shared write');
    // The grant reaches down, never sideways: the space root stays read-only.
    expect((await dav('viewer-secret', '/dav/Family/outside.txt', 'PUT', { body: 'no' })).status).toBe(403);

    // A rename keeps the mount's URL working: the key, not the label, finds it.
    await stub.invoke('drive/rename-folder', { folderId: papers.id, name: 'Documents' });
    expect((await dav('viewer-secret', `${mount}lease.txt`, 'GET')).status).toBe(200);

    await stub.invoke('drive/unshare-folder', { folderId: papers.id, principal: viewer, permission: 'drive:write' });
    expect((await dav('viewer-secret', `${mount}lease.txt`, 'GET')).status).toBe(404);
    expect((await dav('viewer-secret', `${mount}after.txt`, 'PUT', { body: 'no' })).status).toBe(404);
    expect(await hrefs(await dav('viewer-secret', '/dav/', 'PROPFIND'))).not.toContain('/dav/Shared with me/');
    await stub.invoke('drive/rename-folder', { folderId: papers.id, name: 'Papers' });
  });

  it('keeps names distinct when spaces collide with each other or with the virtual collection', async () => {
    const twin = await addSpace('family-2', 'Family', [[owner, 'owner']]);
    const named = await addSpace('shared-1', 'Shared with me', [[owner, 'owner']]);
    const ownStub = await host.getScope(owner, tenant, twin.id);
    const folder = await ownStub.invoke<{ id: string }>('drive/create-folder', { parentId: ROOT_FOLDER_ID, name: 'Grant' });
    // A share to oneself is still a direct grant, which is all the mount needs.
    await host.admin.assignRole(staff, { principalId: viewer, roleKey: 'viewer', node: { tenantId: tenant, scopeId: twin.id } });
    twin.members.set(viewer, 'viewer');
    await ownStub.invoke('drive/share-folder', { folderId: folder.id, principal: viewer, permission: 'drive:write' });

    const ownerRoot = await hrefs(await dav('owner-secret', '/dav/', 'PROPFIND'));
    expect(ownerRoot).toEqual(expect.arrayContaining(['/dav/Family (family-1)/', '/dav/Family (family-2)/', '/dav/Shared with me/']));
    const viewerRoot = await hrefs(await dav('viewer-secret', '/dav/', 'PROPFIND'));
    expect(viewerRoot).toEqual(['/dav/', '/dav/Family (family-1)/', '/dav/Family (family-2)/', '/dav/Shared with me/']);
    expect(named.members.has(viewer)).toBe(false);

    // For the owner, "Shared with me" is their space; once they hold a grant, the
    // virtual collection moves aside rather than hiding the space.
    await dav('owner-secret', '/dav/Shared%20with%20me/mine.txt', 'PUT', { body: 'space file' });
    const workStub = await host.getScope(owner, tenant, work.id);
    const granted = await workStub.invoke<{ id: string }>('drive/create-folder', { parentId: ROOT_FOLDER_ID, name: 'Granted' });
    await workStub.invoke('drive/share-folder', { folderId: granted.id, principal: owner, permission: 'drive:write' });
    expect(await hrefs(await dav('owner-secret', '/dav/', 'PROPFIND'))).toEqual(expect.arrayContaining(['/dav/Shared with me/', '/dav/Shared with me (Canopy 1)/']));
    expect(await (await dav('owner-secret', '/dav/Shared%20with%20me/mine.txt', 'GET')).text()).toBe('space file');
    const owned = (await hrefs(await dav('owner-secret', '/dav/Shared%20with%20me%20(Canopy%201)/', 'PROPFIND'))).slice(1);
    expect(owned).toEqual([expect.stringMatching(/\/Granted — Work \[[0-9a-f]{12}\]\/$/)]);
  });
});
