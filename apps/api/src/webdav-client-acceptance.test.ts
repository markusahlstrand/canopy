import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { createClient, type FileStat, type WebDAVClient } from 'webdav';
import { FileService, createSqlBlobRepo, ensurePersonalSpace, runMigrations, type BlobStore } from '@canopy/store';
import { createLibsqlDb } from '@canopy/store/node';
import { inProcessDocWorker } from '@canopy/docworker';
import { createApp } from './app';

// S12a #14: acceptance of the legacy `Shared with me` WebDAV root with a real WebDAV client
// (the `webdav` package) over a real HTTP socket, instead of Hono's in-process `app.request`.

let service: FileService;
let space: string;
let server: ReturnType<typeof serve>;
let base: string;
const text = (s: string) => new TextEncoder().encode(s);

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
  const app = createApp({ drive: { service, blobs, docWorker: inProcessDocWorker() } });
  server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dav`;
});

afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

async function clientFor(sub: string): Promise<WebDAVClient> {
  const { token } = await service.createAppPassword(sub, 'webdav test client');
  return createClient(base, { username: sub, password: token });
}
const names = async (client: WebDAVClient, path: string) =>
  ((await client.getDirectoryContents(path)) as FileStat[]).map((s) => s.basename);

describe('legacy WebDAV "Shared with me" with a real client', () => {
  it('shows a direct grant, opens its subtree, and enforces viewer rights', async () => {
    await service.putByPath(space, 'owner', 'Photos/a.txt', text('shared'), 'text/plain');
    await service.putByPath(space, 'owner', 'Private/secret.txt', text('secret'), 'text/plain');
    await service.shareFolderGrant({ sub: 'owner' }, space, 'Photos', { subjectType: 'user', subjectId: 'viewer', role: 'viewer' });
    const client = await clientFor('viewer');

    expect(await names(client, '/')).toContain('Shared with me');
    const [mount] = await names(client, '/Shared with me');
    // The URL segment is `<label> [<sha256>]`; the readable `Photos — My Drive [8 hex]` is its displayname.
    expect(mount).toMatch(/^Photos \[[0-9a-f]{64}\]$/);
    const stats = (await client.getDirectoryContents('/Shared with me', { details: true })) as { data: FileStat[] };
    expect(stats.data[0]!.props?.displayname).toMatch(/^Photos — My Drive \[[0-9a-f]{8}\]$/);
    expect(await names(client, `/Shared with me/${mount}`)).toEqual(['a.txt']);
    expect(await client.getFileContents(`/Shared with me/${mount}/a.txt`, { format: 'text' })).toBe('shared');

    await expect(client.putFileContents(`/Shared with me/${mount}/b.txt`, 'nope')).rejects.toMatchObject({ status: 403 });
    await expect(client.createDirectory(`/Shared with me/${mount}/Sub`)).rejects.toMatchObject({ status: 403 });
    await expect(client.deleteFile(`/Shared with me/${mount}/a.txt`)).rejects.toMatchObject({ status: 403 });
    await expect(client.getFileContents(`/Shared with me/${mount}/../Private/secret.txt`)).rejects.toMatchObject({ status: 404 });
    expect(await service.pathKind('owner', space, 'Photos/b.txt')).toBeNull();
  });

  it('lets an editor write inside the mount and nowhere else', async () => {
    await service.createFolder(space, 'owner', 'Photos');
    await service.shareFolderGrant({ sub: 'owner' }, space, 'Photos', { subjectType: 'user', subjectId: 'editor', role: 'editor' });
    const client = await clientFor('editor');
    const [mount] = await names(client, '/Shared with me');

    await client.putFileContents(`/Shared with me/${mount}/e.txt`, 'edited');
    expect(await client.getFileContents(`/Shared with me/${mount}/e.txt`, { format: 'text' })).toBe('edited');
    expect(await service.pathKind('owner', space, 'Photos/e.txt')).toBe('file');
    await expect(client.putFileContents('/Shared with me/loose.txt', 'x')).rejects.toBeDefined();
  });

  it('removes access on revocation, including through an old mount URL', async () => {
    await service.putByPath(space, 'owner', 'Photos/a.txt', text('shared'), 'text/plain');
    await service.shareFolderGrant({ sub: 'owner' }, space, 'Photos', { subjectType: 'user', subjectId: 'viewer', role: 'viewer' });
    const client = await clientFor('viewer');
    const [mount] = await names(client, '/Shared with me');
    const oldUrl = `/Shared with me/${mount}/a.txt`;
    expect(await client.getFileContents(oldUrl, { format: 'text' })).toBe('shared');

    await service.unshareFolderGrant({ sub: 'owner' }, space, 'Photos', { subjectType: 'user', subjectId: 'viewer', role: 'viewer' });

    await expect(client.getFileContents(oldUrl)).rejects.toMatchObject({ status: 404 });
    // The virtual root is gone, so the old mount URL is an ordinary missing path: it lists as empty,
    // exactly like any other missing folder, and exposes none of the revoked content.
    expect(await client.getDirectoryContents(`/Shared with me/${mount}`)).toEqual([]);
    expect(await client.getDirectoryContents('/No such folder')).toEqual([]);
    expect(await names(client, '/')).not.toContain('Shared with me');
  });

  it('keeps colliding folder names distinct and a personal "Shared with me" folder intact', async () => {
    await service.putByPath(space, 'owner', 'Photos/a.txt', text('from owner'), 'text/plain');
    await service.shareFolderGrant({ sub: 'owner' }, space, 'Photos', { subjectType: 'user', subjectId: 'viewer', role: 'viewer' });
    const other = await service.personalSpace('other');
    await service.putByPath(other, 'other', 'Photos/b.txt', text('from other'), 'text/plain');
    await service.shareFolderGrant({ sub: 'other' }, other, 'Photos', { subjectType: 'user', subjectId: 'viewer', role: 'viewer' });
    const personal = await service.personalSpace('viewer');
    await service.putByPath(personal, 'viewer', 'Shared with me/mine.txt', text('personal'), 'text/plain');
    const client = await clientFor('viewer');

    const root = await names(client, '/');
    expect(root).toContain('Shared with me');
    expect(root).toContain('Shared with me (Canopy 1)');
    expect(await names(client, '/Shared with me')).toEqual(['mine.txt']);
    expect(await client.getFileContents('/Shared with me/mine.txt', { format: 'text' })).toBe('personal');

    const mounts = await names(client, '/Shared with me (Canopy 1)');
    expect(mounts).toHaveLength(2);
    expect(new Set(mounts).size).toBe(2);
    const bodies = await Promise.all(mounts.map(async (m) => {
      const [file] = await names(client, `/Shared with me (Canopy 1)/${m}`);
      return client.getFileContents(`/Shared with me (Canopy 1)/${m}/${file}`, { format: 'text' });
    }));
    expect(bodies.sort()).toEqual(['from other', 'from owner']);
  });
});
