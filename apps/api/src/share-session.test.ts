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

describe('web share landing', () => {
  it('exchanges once, redirects without the secret and streams through an HttpOnly cookie', async () => {
    await service.putByPath(space, 'owner', 'note.txt', new TextEncoder().encode('hello'), 'text/plain');
    const file = (await service.getByPath('owner', space, 'note.txt'))!;
    const link = await service.createShare({ sub: 'owner' }, { objectType: 'file', fileId: file.id }, { role: 'viewer' });
    const landing = await app.request(`https://canopy.test/s/${link.secret}`);
    expect(landing.status).toBe(303);
    const location = landing.headers.get('location')!;
    expect(location).toBe(`/s/session/${link.id}`);
    expect(location).not.toContain(link.secret);
    expect(landing.headers.get('referrer-policy')).toBe('no-referrer');
    expect(landing.headers.get('cache-control')).toBe('no-store');
    const cookie = landing.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain(`Path=${location}`);
    expect(cookie).toContain('Max-Age=900');
    expect(cookie).not.toContain(link.secret);
    expect((await app.request(`https://canopy.test${location}`)).status).toBe(404);
    const opened = await app.request(`https://canopy.test${location}`, { headers: { Cookie: cookie.split(';')[0]! } });
    expect(opened.status).toBe(200);
    expect(await opened.text()).toBe('hello');
    await service.revokeShare({ sub: 'owner' }, link.id);
    expect((await app.request(`https://canopy.test${location}`, { headers: { Cookie: cookie.split(';')[0]! } })).status).toBe(404);
  });

  it('does not mint a cookie for an invalid link', async () => {
    const response = await app.request('https://canopy.test/s/invalid');
    expect(response.status).toBe(404);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

