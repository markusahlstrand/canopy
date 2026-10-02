import { beforeEach, describe, expect, it } from 'vitest';
import { FileService, createSqlBlobRepo, ensurePersonalSpace, runMigrations, type BlobStore } from '@canopy/store';
import { createLibsqlDb } from '@canopy/store/node';
import { createApp } from './app';
import { inProcessDocWorker } from '@canopy/docworker';

let service: FileService;
let app: ReturnType<typeof createApp>;
let space: string;

beforeEach(async () => {
  const db = createLibsqlDb(':memory:');
  await runMigrations(db);
  const data = new Map<string, Uint8Array>();
  const blobs: BlobStore = {
    has: async (key) => data.has(key),
    put: async (key, bytes) => { data.set(key, bytes); },
    get: async (key) => data.has(key) ? new Response(data.get(key)! as unknown as BodyInit).body : null,
    delete: async (key) => { data.delete(key); },
  };
  service = new FileService(db, blobs, createSqlBlobRepo(db));
  space = await ensurePersonalSpace(db, 'owner');
  app = createApp({ drive: { service, blobs, docWorker: inProcessDocWorker() } });
});

describe('WebDAV shared-folder discovery', () => {
  it('lists collision-safe mounts, resolves their subtree, and enforces access and revocation', async () => {
    await service.putByPath(space, 'owner', 'Photos/a.txt', new TextEncoder().encode('shared'), 'text/plain');
    await service.putByPath(space, 'owner', 'Private/secret.txt', new TextEncoder().encode('secret'), 'text/plain');
    await service.shareFolderGrant({ sub: 'owner' }, space, 'Photos', { subjectType: 'user', subjectId: 'recipient', role: 'viewer' });
    const other = await service.personalSpace('other');
    await service.putByPath(other, 'other', 'Photos/b.txt', new TextEncoder().encode('second'), 'text/plain');
    await service.shareFolderGrant({ sub: 'other' }, other, 'Photos', { subjectType: 'user', subjectId: 'recipient', role: 'viewer' });
    const { token } = await service.createAppPassword('recipient', 'Finder');
    const headers = { Authorization: `Basic ${btoa(`recipient:${token}`)}` };
    const request = (path: string, method = 'PROPFIND') => app.request(`https://canopy.test${path}`, { method, headers });
    const root = await request('/dav');
    expect(root.status).toBe(207);
    expect(await root.text()).toContain('/dav/Shared%20with%20me/');
    const listing = await request('/dav/Shared%20with%20me/');
    const xml = await listing.text();
    const hrefs = [...xml.matchAll(/<D:href>([^<]+)<\/D:href>/g)].map((m) => m[1]!);
    const mounts = hrefs.slice(1);
    expect(new Set(mounts).size).toBe(2);
    const contents = await Promise.all(mounts.map(async (path) => (await request(path)).text()));
    const first = mounts[contents.findIndex((body) => body.includes('a.txt'))]!;
    expect(await (await request(`${first}a.txt`, 'GET')).text()).toBe('shared');
    expect((await request(`${first}a.txt`, 'PUT')).status).toBe(403);
    expect((await request(`${first}..%2FPrivate%2Fsecret.txt`, 'GET')).status).toBe(404);
    await service.unshareFolderGrant({ sub: 'owner' }, space, 'Photos', { subjectType: 'user', subjectId: 'recipient', role: 'viewer' });
    expect((await request(`${first}a.txt`, 'GET')).status).toBe(404);
  });

  it('preserves a personal folder whose name matches the virtual collection', async () => {
    await service.putByPath(space, 'owner', 'Photos/a.txt', new TextEncoder().encode('shared'), 'text/plain');
    await service.shareFolderGrant({ sub: 'owner' }, space, 'Photos', { subjectType: 'user', subjectId: 'recipient', role: 'viewer' });
    const personal = await service.personalSpace('recipient');
    await service.putByPath(personal, 'recipient', 'Shared with me/personal.txt', new TextEncoder().encode('personal'), 'text/plain');
    const { token } = await service.createAppPassword('recipient', 'Finder');
    const headers = { Authorization: `Basic ${btoa(`recipient:${token}`)}` };
    const root = await app.request('/dav', { method: 'PROPFIND', headers });
    const xml = await root.text();
    expect(xml).toContain('/dav/Shared%20with%20me/');
    expect(xml).toContain('/dav/Shared%20with%20me%20(Canopy%201)/');
    const file = await app.request('/dav/Shared%20with%20me/personal.txt', { headers });
    expect(await file.text()).toBe('personal');
  });

  it('lets a user without shares create, rename, and write the virtual-root name', async () => {
    const personal = await service.personalSpace('recipient');
    const { token } = await service.createAppPassword('recipient', 'Finder');
    const headers = { Authorization: `Basic ${btoa(`recipient:${token}`)}` };
    const request = (path: string, method: string, extra: RequestInit = {}) =>
      app.request(path, { ...extra, method, headers: { ...headers, ...extra.headers } });
    const root = await request('/dav', 'PROPFIND');
    expect(await root.text()).not.toContain('/dav/Shared%20with%20me/');
    expect((await request('/dav/Shared%20with%20me/', 'MKCOL')).status).toBe(201);
    expect(await service.pathKind('recipient', personal, 'Shared with me')).toBe('folder');
    expect((await request('/dav/Shared%20with%20me/', 'DELETE')).status).toBe(204);

    expect((await request('/dav/Notes/', 'MKCOL')).status).toBe(201);
    expect((await request('/dav/Notes/', 'MOVE', {
      headers: { Destination: '/dav/Shared%20with%20me/' },
    })).status).toBe(201);
    expect(await service.pathKind('recipient', personal, 'Shared with me')).toBe('folder');
    expect((await request('/dav/Shared%20with%20me/', 'DELETE')).status).toBe(204);

    expect((await request('/dav/Shared%20with%20me', 'PUT', { body: 'personal bytes' })).status).toBe(201);
    expect(await (await request('/dav/Shared%20with%20me', 'GET')).text()).toBe('personal bytes');
    const listing = await request('/dav/Shared%20with%20me', 'PROPFIND');
    expect(listing.status).toBe(207);
    expect(await listing.text()).toContain('<D:getcontentlength>14</D:getcontentlength>');
  });

  it('lets an editor create, write, move, and delete inside a shared mount', async () => {
    await service.createFolder(space, 'owner', 'Photos');
    await service.shareFolderGrant({ sub: 'owner' }, space, 'Photos', { subjectType: 'user', subjectId: 'recipient', role: 'editor' });
    const { token } = await service.createAppPassword('recipient', 'Finder');
    const headers = { Authorization: `Basic ${btoa(`recipient:${token}`)}` };
    const request = (path: string, method: string, extra: RequestInit = {}) =>
      app.request(path, { ...extra, method, headers: { ...headers, ...extra.headers } });
    const listing = await request('/dav/Shared%20with%20me/', 'PROPFIND');
    const mount = [...(await listing.text()).matchAll(/<D:href>([^<]+)<\/D:href>/g)][1]![1]!;
    expect((await request(`${mount}New/`, 'MKCOL')).status).toBe(201);
    expect((await request(`${mount}New/a.txt`, 'PUT', { body: 'edited' })).status).toBe(201);
    expect(await (await request(`${mount}New/a.txt`, 'GET')).text()).toBe('edited');
    expect((await request(`${mount}New/`, 'MOVE', { headers: { Destination: `${mount}Renamed/` } })).status).toBe(201);
    expect(await service.pathKind('owner', space, 'Photos/New')).toBeNull();
    expect(await (await request(`${mount}Renamed/a.txt`, 'GET')).text()).toBe('edited');
    expect((await request(`${mount}Renamed/a.txt`, 'DELETE')).status).toBe(204);
    expect(await service.pathKind('owner', space, 'Photos/Renamed/a.txt')).toBeNull();
    expect((await request(`${mount}Renamed/`, 'DELETE')).status).toBe(204);
    expect(await service.pathKind('owner', space, 'Photos/Renamed')).toBeNull();
  });

  it('rejects MOVE and COPY from an editor mount into the personal space', async () => {
    await service.putByPath(space, 'owner', 'Photos/a.txt', new TextEncoder().encode('shared'), 'text/plain');
    await service.shareFolderGrant({ sub: 'owner' }, space, 'Photos', { subjectType: 'user', subjectId: 'recipient', role: 'editor' });
    const personal = await service.personalSpace('recipient');
    const { token } = await service.createAppPassword('recipient', 'Finder');
    const headers = { Authorization: `Basic ${btoa(`recipient:${token}`)}` };
    const listing = await app.request('/dav/Shared%20with%20me/', { method: 'PROPFIND', headers });
    const mount = [...(await listing.text()).matchAll(/<D:href>([^<]+)<\/D:href>/g)][1]![1]!;
    for (const method of ['MOVE', 'COPY']) {
      const response = await app.request(`${mount}a.txt`, {
        method, headers: { ...headers, Destination: 'https://canopy.test/dav/copied.txt' },
      });
      expect(response.status).toBe(502);
      expect(await response.text()).toBe(`Cannot ${method.toLowerCase()} across spaces`);
      expect(await service.pathKind('recipient', personal, 'copied.txt')).toBeNull();
      const original = await app.request(`${mount}a.txt`, { headers });
      expect(await original.text()).toBe('shared');
    }
  });

});
