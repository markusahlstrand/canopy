/// <reference types="node" />
/**
 * Uploads through the assistant's MCP endpoint and upload links, against the REAL drive module
 * (`SqliteScopeHost`): the permission checks, the duplicate rule, the a3doc send and the `arrived`
 * queue are the kernel's and the module's own, not fakes of them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId, type ScopeId } from '@substrat-run/contracts';
import { ulid, type ScopeStub } from '@substrat-run/kernel';
import { driveManifest, driveModule, ROOT_FOLDER_ID } from '@canopy/scope-drive';
import { driveOperations } from '@canopy/scope-drive/spec/model';
import { ROLES } from '../src/provision';
import { assistantAccess, mountAssistantMcp, MAX_MCP_BODY_BYTES, type AssistantDirectory } from '../src/assistant-mcp';
import { checkedUpload, decodeBase64, mountUploadLinks, uploadToFolder, uploadTokenHash, uploadTypeOf, MAX_INLINE_UPLOAD_BYTES, UPLOAD_LINK_TTL_MS, type UploadTarget } from '../src/upload';
import { claimUploadLink, createUploadLink, MAX_LIVE_UPLOAD_LINKS, peekUploadLink } from '../src/upload-links';
import type { DirectorySql } from '../src/space-creation';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** A ZIP of stored (uncompressed) entries: local headers, central directory, end record. CRCs are left 0. */
function zipOf(entries: { name: string; data: string }[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  const header = (size: number, write: (v: DataView, bytes: Uint8Array) => void) => {
    const bytes = new Uint8Array(size); write(new DataView(bytes.buffer), bytes); return bytes;
  };
  for (const entry of entries) {
    const name = enc.encode(entry.name), data = enc.encode(entry.data);
    const local = header(30 + name.length, (v, b) => {
      v.setUint32(0, 0x04034b50, true); v.setUint16(8, 0, true); v.setUint32(18, data.length, true); v.setUint32(22, data.length, true);
      v.setUint16(26, name.length, true); b.set(name, 30);
    });
    central.push(header(46 + name.length, (v, b) => {
      v.setUint32(0, 0x02014b50, true); v.setUint16(10, 0, true); v.setUint32(20, data.length, true); v.setUint32(24, data.length, true);
      v.setUint16(28, name.length, true); v.setUint32(42, offset, true); b.set(name, 46);
    }));
    parts.push(local, data);
    offset += local.length + data.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = header(22, (v) => {
    v.setUint32(0, 0x06054b50, true); v.setUint16(8, entries.length, true); v.setUint16(10, entries.length, true);
    v.setUint32(12, size, true); v.setUint32(16, offset, true);
  });
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

function linkDb(): DirectorySql {
  const db = new DatabaseSync(':memory:');
  return { exec: (query, ...values) => { const stmt = db.prepare(query); return stmt.columns().length ? stmt.all(...values) : (stmt.run(...values), []); } };
}

/**
 * One install with three spaces: `files` (plain storage), `gestoria` (a3doc, takes uploads) and
 * `bank` (a Qonto mirror). Ada owns all three; in `files` Eve is an editor and Vic a viewer.
 * Mallory is signed in and in no space at all.
 */
async function world() {
  const dir = mkdtempSync(join(tmpdir(), 'upload-')); dirs.push(dir);
  const host = new SqliteScopeHost({ dir }); host.registerModule(driveModule);
  const staff = platformActorId.parse(ulid()), t = tenantId.parse(ulid());
  await host.admin.createTenant(staff, { id: t, slug: 'up', name: 'Up' });
  await host.admin.grantEntitlement(staff, t, driveManifest.entitlementKey as string);
  await host.provisionBlobStore(staff, { tenantId: t, vertical: 'drive', binding: 'BLOBS' });
  for (const role of ROLES) await host.admin.defineRole(staff, t, role);

  const spaces: Record<string, ScopeId> = {};
  const bound = new Map<string, string>(); // `${scope}|${sub}` → principal
  const bind = async (slug: string, sub: string, role: string) => {
    const p = principalId.parse(ulid());
    await host.admin.assignRole(staff, { principalId: p, roleKey: role, node: { tenantId: t, scopeId: spaces[slug]! } });
    bound.set(`${spaces[slug]}|${sub}`, p);
  };
  for (const slug of ['files', 'gestoria', 'bank']) {
    const s = scopeId.parse(ulid());
    spaces[slug] = s;
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'drive' });
    await host.admin.activateScope(staff, t, s);
    await bind(slug, 'ada', 'owner');
  }
  await bind('files', 'eve', 'editor');
  await bind('files', 'vic', 'viewer');
  const as = (slug: string, sub = 'ada') => host.getScope(principalId.parse(bound.get(`${spaces[slug]}|${sub}`)!), t, spaces[slug]!);

  // The a3doc tree: the folder a sales invoice goes in, and an accounting category for its month.
  const ada = await as('gestoria');
  const folder = async (parentId: string, name: string) => (await ada.invoke<{ id: string }>('drive/create-folder', { parentId, name })).id;
  const emitidas = await folder(await folder(ROOT_FOLDER_ID, 'Facturas a contabilizar'), 'Facturas emitidas');
  const month = await folder(await folder(await folder(await folder(ROOT_FOLDER_ID, 'CONTABILIDAD-ACCOUNTING'), 'DOC CONTABLE-DOC ACCOUNTING'), '2026'), '11');
  await ada.invoke('drive/record-source', { provider: 'canopy.a3doc', connectionId: 'c', account: 'ACME', folder: 'F', canUpload: true });
  await (await as('bank')).invoke('drive/record-source', { provider: 'canopy.qonto', connectionId: 'q', account: 'ACME', folder: '', canUpload: false });
  const inFiles = await (await as('files')).invoke<{ id: string }>('drive/create-folder', { parentId: ROOT_FOLDER_ID, name: 'Invoices' });

  const afterWrite = vi.fn(async () => {});
  const stored = vi.fn();
  const targetAs = async (principal: string, scope: string): Promise<Omit<UploadTarget, 'scope'>> => ({
    store: async (fileId, name, mime, body) => {
      stored(scope, name, mime, body.byteLength);
      const bytes = await host.attachments(principalId.parse(principal), t, scopeId.parse(scope));
      return (await bytes.upload({ entity: { entityType: 'file', entityId: fileId }, filename: name, contentType: mime, visibility: 'internal', body })).id;
    },
    afterWrite,
  });
  const links = linkDb();
  let offset = 0;
  const clock = () => Date.now() + offset;
  const directory: AssistantDirectory = {
    listSites: async () => Object.entries(spaces).map(([slug, id]) => ({ slug, name: slug, scopeId: id })),
    resolveSiteScope: async (slug) => spaces[slug] ?? null,
    principalIn: async (scope, sub) => bound.get(`${scope}|${sub}`) ?? null,
    settings: async () => null,
    scopeAs: (principal, scope) => host.getScope(principalId.parse(principal), t, scopeId.parse(scope)),
    uploadsAs: targetAs,
    saveUploadLink: async (link) => createUploadLink(links, { ...link, now: clock() }),
  };

  const app = new Hono();
  app.onError((err, c) => (err instanceof HTTPException ? c.json({ detail: err.message }, err.status) : c.json({ detail: String(err) }, 500)));
  mountAssistantMcp(app, driveOperations, async (_c, headers) => {
    const sub = headers.get('authorization')?.replace(/^Bearer /, '');
    if (!sub) throw new HTTPException(401, { message: 'unauthorized' });
    return {
      access: assistantAccess(directory, sub, async () => new Response('{}'), 'https://canopy.test'),
      ids: { tenantId: t, scopeId: spaces.files! } as Pick<ScopeStub, 'tenantId' | 'scopeId'>,
    };
  });
  mountUploadLinks(app, async () => ({
    peek: async (hash) => peekUploadLink(links, hash, clock()),
    claim: async (hash) => claimUploadLink(links, hash, clock()),
    targetFor: async (sub, scope) => {
      const principal = bound.get(`${scope}|${sub}`);
      if (!principal) return null;
      return { scope: await host.getScope(principalId.parse(principal), t, scopeId.parse(scope)), ...(await targetAs(principal, scope)) };
    },
    now: clock,
  }));

  let id = 0;
  const tool = async (sub: string, name: string, args: Record<string, unknown>) => {
    const res = await app.request('/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sub}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
    const body = await res.json() as { result: { content: { text: string }[]; isError?: boolean } };
    const text = body.result.content[0]!.text;
    return { isError: body.result.isError === true, text, value: body.result.isError ? null : JSON.parse(text) };
  };
  const put = (url: string, body: Uint8Array, headers: Record<string, string> = { 'content-type': 'application/pdf' }) =>
    app.request(new URL(url).pathname, { method: 'PUT', headers, body });

  const count = async (slug: string, sql: string) => Number((await host.admin.queryScope(staff, t, spaces[slug]!, { sql })).rows[0]![0]);
  const files = (slug: string) => count(slug, 'SELECT COUNT(*) FROM drive_files');
  const sends = (slug: string) => count(slug, "SELECT COUNT(*) FROM _substrat_outbox WHERE type = 'a3doc.files-requested'");
  const lastSend = async () => JSON.parse(String((await host.admin.queryScope(staff, t, spaces.gestoria!, { sql: "SELECT payload FROM _substrat_outbox WHERE type = 'a3doc.files-requested' ORDER BY id DESC LIMIT 1" })).rows[0]![0])) as Record<string, unknown>;
  const arrivals = async (slug: string) => (await (await as(slug)).invoke<{ items: { fileId: string; trigger: string; actor: string | null }[] }>('drive/automation-claim', {})).items;

  const versions = (slug: string, fileId: string) => count(slug, `SELECT COUNT(*) FROM drive_file_versions WHERE file_id = '${fileId}'`);
  return { app, tool, put, as, bind, bound, spaces, emitidas, month, inFiles, afterWrite, stored, files, sends, lastSend, arrivals, versions, targetAs, links, advance: (ms: number) => { offset += ms; } };
}

describe('drive_upload-file', () => {
  it('files a document for an owner, as a new version that arrives for flows', async () => {
    const w = await world();
    const up = await w.tool('ada', 'drive_upload-file', { space: 'files', folderId: w.inFiles.id, name: 'Invoice 7.pdf', contentBase64: b64(PDF) });
    expect(up.isError).toBe(false);
    expect(up.value).toMatchObject({ created: true, file: { name: 'Invoice 7.pdf', folderId: w.inFiles.id }, source: null });
    expect(up.value.file.currentVersionId).toEqual(expect.any(String));
    expect(w.stored).toHaveBeenCalledWith(w.spaces.files, 'Invoice 7.pdf', 'application/pdf', PDF.byteLength);
    // The same `arrived` an app upload queues, with the uploader as the actor, and the dispatcher kicked.
    expect(await w.arrivals('files')).toEqual([expect.objectContaining({ fileId: up.value.file.id, trigger: 'arrived', actor: w.bound.get(`${w.spaces.files}|ada`) })]);
    expect(w.afterWrite).toHaveBeenCalledTimes(1);
  });

  it('lets an editor upload, and denies a viewer before anything is written', async () => {
    const w = await world();
    expect((await w.tool('eve', 'drive_upload-file', { space: 'files', folderId: w.inFiles.id, name: 'a.pdf', contentBase64: b64(PDF) })).value).toMatchObject({ created: true });
    const before = await w.files('files');
    const denied = await w.tool('vic', 'drive_upload-file', { space: 'files', folderId: w.inFiles.id, name: 'b.pdf', contentBase64: b64(PDF) });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('owner or editor');
    expect(await w.files('files')).toBe(before);
    expect(w.stored).toHaveBeenCalledTimes(1);
    // A viewer asking for a name that exists is denied too, not handed the file.
    expect((await w.tool('vic', 'drive_upload-file', { space: 'files', folderId: w.inFiles.id, name: 'a.pdf', contentBase64: b64(PDF) })).isError).toBe(true);
  });

  it('is the kernel that refuses a viewer, even past the early check', async () => {
    const w = await world();
    // Straight at the module, as the shared upload path calls it: ensure-file checks drive:write itself.
    await expect((await w.as('files', 'vic')).invoke('drive/ensure-file', { folderId: w.inFiles.id, name: 'x.pdf' })).rejects.toThrow();
  });

  it('checks who may write before it decodes or looks at the bytes', async () => {
    const w = await world();
    // Bytes that would fail decoding: the refusal a viewer or non-member gets is about access, not about them.
    const viewer = await w.tool('vic', 'drive_upload-file', { space: 'files', folderId: w.inFiles.id, name: 'a.pdf', contentBase64: '***' });
    expect(viewer.isError).toBe(true);
    expect(viewer.text).toContain('owner or editor');
    const stranger = await w.tool('mallory', 'drive_upload-file', { space: 'files', folderId: w.inFiles.id, name: 'a.pdf', contentBase64: '***' });
    expect(stranger.text).toMatch(/no space 'files' that you can open/);
    // The same bytes from an owner are judged on what they are.
    expect((await w.tool('ada', 'drive_upload-file', { space: 'files', folderId: w.inFiles.id, name: 'a.pdf', contentBase64: '***' })).text).toContain('not valid base64');
  });

  it('refuses a space the login is not a member of', async () => {
    const w = await world();
    const refused = await w.tool('mallory', 'drive_upload-file', { space: 'files', folderId: w.inFiles.id, name: 'a.pdf', contentBase64: b64(PDF) });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toMatch(/no space 'files' that you can open/);
    expect(w.stored).not.toHaveBeenCalled();
  });

  it('files an invoice in an a3doc folder and its accounting category, and a repeat returns it without sending it again', async () => {
    const w = await world();
    const args = { space: 'gestoria', folderId: w.emitidas, name: 'F-2026-0042.pdf', contentBase64: b64(PDF), alsoIn: [w.month] };
    const first = await w.tool('ada', 'drive_upload-file', args);
    expect(first.value).toMatchObject({
      created: true,
      source: { provider: 'canopy.a3doc', sent: true, alsoIn: ['CONTABILIDAD-ACCOUNTING/DOC CONTABLE-DOC ACCOUNTING/2026/11'] },
    });
    expect(await w.lastSend()).toMatchObject({ directory: 'Facturas a contabilizar/Facturas emitidas', alsoIn: ['CONTABILIDAD-ACCOUNTING/DOC CONTABLE-DOC ACCOUNTING/2026/11'] });
    expect(await w.sends('gestoria')).toBe(1);

    const again = await w.tool('ada', 'drive_upload-file', args);
    expect(again.value).toMatchObject({ created: false, file: { id: first.value.file.id, currentVersionId: first.value.file.currentVersionId }, source: null });
    // Nothing stored, no new version, and a3doc is not asked twice.
    expect(w.stored).toHaveBeenCalledTimes(1);
    expect(await w.sends('gestoria')).toBe(1);
    expect(await w.arrivals('gestoria')).toHaveLength(1);
  });

  it('lets only one of two uploads racing to a new name become its version; the other returns it', async () => {
    const w = await world();
    const scope = await w.as('files');
    const ada = w.bound.get(`${w.spaces.files}|ada`)!;
    const plain = { scope, ...(await w.targetAs(ada, w.spaces.files!)) };
    // The loser has seen the name empty and stored its bytes when the winner lands its whole upload.
    const loser: UploadTarget = {
      ...plain,
      store: async (fileId, name, mime, body) => {
        const id = await plain.store(fileId, name, mime, body);
        await uploadToFolder(plain, { folderId: w.inFiles.id, name, mime, body: async () => body, existing: 'keep' });
        return id;
      },
    };
    const lost = await uploadToFolder(loser, { folderId: w.inFiles.id, name: 'race.pdf', mime: 'application/pdf', body: async () => PDF, existing: 'keep' });
    expect(lost).toMatchObject({ created: false, wrote: false, source: null });
    expect(lost.file.current_version_id).toEqual(expect.any(String));
    expect(await w.versions('files', lost.file.id)).toBe(1);
    expect(await w.arrivals('files')).toHaveLength(1);

    // "New → …" (refuse) answers the loser with the usual 409.
    const refusing: UploadTarget = { ...loser };
    await expect(uploadToFolder(refusing, { folderId: w.inFiles.id, name: 'race-2.pdf', mime: 'application/pdf', body: async () => PDF, existing: 'refuse' }))
      .rejects.toThrow("already has a file named 'race-2.pdf'");

    // The app's drag-and-drop (version) keeps writing a new version, as for any existing file.
    const versioning: UploadTarget = { ...loser };
    const both = await uploadToFolder(versioning, { folderId: w.inFiles.id, name: 'race-3.pdf', mime: 'application/pdf', body: async () => PDF, existing: 'version' });
    expect(await w.versions('files', both.file.id)).toBe(2);
  });

  it('refuses alsoIn outside a3doc, and a category folder that is not there, before writing', async () => {
    const w = await world();
    const storage = await w.tool('ada', 'drive_upload-file', { space: 'files', folderId: w.inFiles.id, name: 'a.pdf', contentBase64: b64(PDF), alsoIn: [w.inFiles.id] });
    expect(storage).toMatchObject({ isError: true });
    expect(storage.text).toContain('only for a3doc spaces');
    const missing = await w.tool('ada', 'drive_upload-file', { space: 'gestoria', folderId: w.emitidas, name: 'a.pdf', contentBase64: b64(PDF), alsoIn: ['no-such-folder'] });
    expect(missing).toMatchObject({ isError: true });
    expect(missing.text).toContain("no category folder 'no-such-folder'");
    expect(w.stored).not.toHaveBeenCalled();
    expect(await w.sends('gestoria')).toBe(0);
  });

  it('keeps a Qonto space read-only', async () => {
    const w = await world();
    const refused = await w.tool('ada', 'drive_upload-file', { space: 'bank', folderId: ROOT_FOLDER_ID, name: 'receipt.pdf', contentBase64: b64(PDF) });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain('mirrors a Qonto account and takes no uploads');
    expect(await w.files('bank')).toBe(0);
  });

  it('refuses a type it does not take, bytes that are not what the name says, and bad or oversized input', async () => {
    const w = await world();
    const call = (name: string, contentBase64: string) => w.tool('ada', 'drive_upload-file', { space: 'files', folderId: w.inFiles.id, name, contentBase64 });
    expect((await call('run.exe', b64(PDF))).text).toContain("'.exe' can't be uploaded");
    expect((await call('page.html', b64(new TextEncoder().encode('<p>hi</p>')))).text).toContain("'.html' can't be uploaded");
    expect((await call('fake.pdf', b64(new TextEncoder().encode('not a pdf')))).text).toContain('not a .pdf file');
    expect((await call('a.pdf', '***')).text).toContain('not valid base64');
    expect((await call('a.pdf', 'A'.repeat(Math.ceil((MAX_INLINE_UPLOAD_BYTES + 3) / 3) * 4))).text).toContain('drive_create-upload-link');
    expect(w.stored).not.toHaveBeenCalled();
  });

  it('refuses an MCP request too large to hold before parsing it', async () => {
    const w = await world();
    const res = await w.app.request('/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ada', 'content-length': String(MAX_MCP_BODY_BYTES + 1) }, body: '{}' });
    expect(res.status).toBe(413);
  });
});

describe('drive_create-upload-link', () => {
  const linkFor = async (w: Awaited<ReturnType<typeof world>>, sub = 'ada', over: Record<string, unknown> = {}) =>
    w.tool(sub, 'drive_create-upload-link', { space: 'gestoria', folderId: w.emitidas, name: 'F-2026-0043.pdf', alsoIn: [w.month], ...over });

  it('takes the bytes once, filed as drive_upload-file would, including a3doc categories', async () => {
    const w = await world();
    const link = await linkFor(w);
    expect(link.value).toMatchObject({ method: 'PUT', contentType: 'application/pdf', url: expect.stringMatching(/^https:\/\/canopy\.test\/api\/upload-links\/canopy_up_/) });
    // Only the hash is kept.
    const token = link.value.url.split('/').pop()!;
    expect([...w.links.exec('SELECT token_hash FROM canopy_upload_links')]).toEqual([{ token_hash: await uploadTokenHash(token) }]);

    const res = await w.put(link.value.url, PDF);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ created: true, source: { sent: true, alsoIn: ['CONTABILIDAD-ACCOUNTING/DOC CONTABLE-DOC ACCOUNTING/2026/11'] } });
    expect(await w.sends('gestoria')).toBe(1);
    expect(await w.arrivals('gestoria')).toHaveLength(1);

    // Used once: a second PUT, even of the same bytes, is refused.
    const second = await w.put(link.value.url, PDF);
    expect(second.status).toBe(410);
    expect(w.stored).toHaveBeenCalledTimes(1);
  });

  it('expires after ten minutes', async () => {
    const w = await world();
    const link = await linkFor(w);
    w.advance(10 * 60 * 1000 + 1);
    const res = await w.put(link.value.url, PDF);
    expect(res.status).toBe(410);
    expect(w.stored).not.toHaveBeenCalled();
    expect(await w.sends('gestoria')).toBe(0);
  });

  it('is refused to a viewer when asked for, and to someone removed from the space when used', async () => {
    const w = await world();
    const viewer = await linkFor(w, 'vic', { space: 'files', folderId: w.inFiles.id, alsoIn: undefined });
    expect(viewer).toMatchObject({ isError: true });
    expect(viewer.text).toContain('owner or editor');

    const eve = await linkFor(w, 'eve', { space: 'files', folderId: w.inFiles.id, alsoIn: undefined });
    w.bound.delete(`${w.spaces.files}|eve`);
    const res = await w.put(eve.value.url, PDF);
    expect(res.status).toBe(403);
    expect(w.stored).not.toHaveBeenCalled();
  });

  it('checks the type and size, without spending the link on a mistake it can name first', async () => {
    const w = await world();
    const link = await linkFor(w);
    expect((await w.put(link.value.url, PDF, { 'content-type': 'image/png' })).status).toBe(415);
    expect((await w.put(link.value.url, PDF, { 'content-type': 'application/pdf', 'content-length': String(26 * 1024 * 1024) })).status).toBe(413);
    // Still usable.
    expect((await w.put(link.value.url, PDF)).status).toBe(201);
    // Bytes that are not a PDF are caught after reading, and that spends it.
    const other = await linkFor(w, 'ada', { name: 'other.pdf' });
    expect((await w.put(other.value.url, new TextEncoder().encode('nope'))).status).toBe(415);
  });

  it('answers with the existing file for a name already taken, without filing it again', async () => {
    const w = await world();
    await w.tool('ada', 'drive_upload-file', { space: 'gestoria', folderId: w.emitidas, name: 'F-2026-0043.pdf', contentBase64: b64(PDF) });
    const link = await linkFor(w);
    const res = await w.put(link.value.url, PDF);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: false });
    expect(await w.sends('gestoria')).toBe(1);
  });

  it('refuses an unknown token', async () => {
    const w = await world();
    expect((await w.put('https://canopy.test/api/upload-links/canopy_up_nope', PDF)).status).toBe(410);
  });
});

describe('upload checks', () => {
  it('knows each accepted type by its bytes', () => {
    expect(checkedUpload('a.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(checkedUpload('a.JPG', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    const docx = zipOf([{ name: '[Content_Types].xml', data: '<Types/>' }, { name: 'word/document.xml', data: '<w:document/>' }]);
    expect(checkedUpload('a.docx', docx)).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(checkedUpload('a.xlsx', docx)).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const odt = zipOf([{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.text' }, { name: 'content.xml', data: '<office/>' }]);
    expect(checkedUpload('a.odt', odt)).toBe('application/vnd.oasis.opendocument.text');
    expect(checkedUpload('a.heic', new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode('ftypheic')]))).toBe('image/heic');
    expect(checkedUpload('factura.xsig', new TextEncoder().encode('<?xml version="1.0"?><fe:Facturae/>'))).toBe('application/xml');
    expect(() => checkedUpload('a.csv', new Uint8Array([0x61, 0x00, 0x62]))).toThrow('not a .csv file');
    // A ZIP that is only a ZIP is an archive, whatever it is named.
    const notes = zipOf([{ name: 'notes.txt', data: 'hello' }]);
    expect(() => checkedUpload('invoice.docx', notes)).toThrow('not a .docx file');
    expect(() => checkedUpload('invoice.odt', notes)).toThrow('not a .odt file');
    // An OpenDocument package must name its own type, not another's.
    expect(() => checkedUpload('a.ods', odt)).toThrow('not a .ods file');
    // The signature alone is not a package.
    expect(() => checkedUpload('a.docx', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1]))).toThrow('not a .docx file');
    // Only the table's own extensions, never inherited names.
    for (const name of ['invoice.constructor', 'a.__proto__', 'a.toString', 'a.hasOwnProperty']) {
      expect(() => uploadTypeOf(name), name).toThrow("can't be uploaded");
    }
    expect(() => checkedUpload('a.pdf', new Uint8Array())).toThrow('empty');
    expect(() => checkedUpload('noextension', PDF)).toThrow("can't be uploaded");
  });

  it('decodes strict base64 only', () => {
    expect([...decodeBase64('aGk=')]).toEqual([0x68, 0x69]);
    expect(() => decodeBase64('aGk')).toThrow('not valid base64');
  });
});

describe('the upload-link store', () => {
  // Links made at `now` expire UPLOAD_LINK_TTL_MS later: TTL is the store's, from the clock it is handed.
  const TTL = UPLOAD_LINK_TTL_MS;
  const link = (over: Record<string, unknown> = {}) => ({ tokenHash: 'h1', sub: 'ada', scopeId: 's', folderId: 'f', name: 'a.pdf', alsoIn: ['c'], now: 0, ...over });

  it('claims a link once, and not after it expires', () => {
    const sql = linkDb();
    expect(createUploadLink(sql, link())).toEqual({ ok: true, expiresAt: TTL });
    createUploadLink(sql, link({ tokenHash: 'h2' }));
    expect(peekUploadLink(sql, 'h1', 10)).toEqual({ sub: 'ada', scopeId: 's', folderId: 'f', name: 'a.pdf', alsoIn: ['c'], expiresAt: TTL });
    expect(claimUploadLink(sql, 'h1', 10)).toBe(true);
    expect(claimUploadLink(sql, 'h1', 11)).toBe(false);
    expect(peekUploadLink(sql, 'h1', 11)).toBeNull();
    expect(claimUploadLink(sql, 'h2', TTL - 1)).toBe(true);
    createUploadLink(sql, link({ tokenHash: 'h3' }));
    expect(claimUploadLink(sql, 'h3', TTL)).toBe(false);
    expect(claimUploadLink(sql, 'unknown', 10)).toBe(false);
  });

  it('prunes spent and expired links, and caps the live ones per login', () => {
    const sql = linkDb();
    for (let i = 0; i < MAX_LIVE_UPLOAD_LINKS; i++) expect(createUploadLink(sql, link({ tokenHash: `h${i}` }))).toMatchObject({ ok: true });
    expect(createUploadLink(sql, link({ tokenHash: 'over' }))).toEqual({ error: 'limit' });
    // Another login has its own allowance.
    expect(createUploadLink(sql, link({ tokenHash: 'bob', sub: 'bob' }))).toMatchObject({ ok: true });
    claimUploadLink(sql, 'h0', 1);
    expect(createUploadLink(sql, link({ tokenHash: 'next', now: 2 }))).toMatchObject({ ok: true });
    // Once they have all expired, they are pruned on the next mint.
    expect(createUploadLink(sql, link({ tokenHash: 'later', now: TTL + 2 }))).toMatchObject({ ok: true });
    expect([...sql.exec('SELECT token_hash FROM canopy_upload_links ORDER BY token_hash')]).toEqual([{ token_hash: 'later' }]);
  });
});
