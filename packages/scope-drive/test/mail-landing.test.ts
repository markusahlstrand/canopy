import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { driveManifest, driveModule, DRIVE_PERM } from '../src/index.js';
import { mailName } from '../src/mail-landing.js';
import { ROOT_FOLDER_ID } from '../src/migrations.js';
import { ROLES } from '../src/provision.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const CONN = ulid();
type Ref = { entityType: string; entityId: string };
type Answer = { entity?: Ref; raw?: boolean; ok?: boolean };

async function world() {
  const dir = mkdtempSync(join(tmpdir(), 'mail-landing-')); dirs.push(dir);
  const host = new SqliteScopeHost({ dir }); host.registerModule(driveModule);
  const staff = platformActorId.parse(ulid()), t = tenantId.parse(ulid()), s = scopeId.parse(ulid());
  const owner = principalId.parse(ulid()), address = principalId.parse(ulid()), viewer = principalId.parse(ulid());
  await host.admin.createTenant(staff, { id: t, slug: 'mail', name: 'Mail' });
  await host.admin.grantEntitlement(staff, t, driveManifest.entitlementKey as string);
  await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'drive' });
  await host.admin.activateScope(staff, t, s);
  await host.provisionBlobStore(staff, { tenantId: t, vertical: 'drive', binding: 'BLOBS' });
  for (const role of ROLES) await host.admin.defineRole(staff, t, role);
  await host.admin.assignRole(staff, { principalId: owner, roleKey: 'owner', node: { tenantId: t, scopeId: s } });
  await host.admin.assignRole(staff, { principalId: viewer, roleKey: 'viewer', node: { tenantId: t, scopeId: s } });
  // What the platform grants an address: the declared key on this scope, and nothing else.
  await host.admin.grant(staff, { principalId: address, permission: DRIVE_PERM.receiveMail, node: { tenantId: t, scopeId: s }, grantedBy: address });
  const mail = await host.getScope(address, t, s), human = await host.getScope(owner, t, s), reader = await host.getScope(viewer, t, s);
  const bytes = await host.attachments(address, t, s);
  const ownerBytes = await host.attachments(owner, t, s);
  const viewerBytes = await host.attachments(viewer, t, s);
  const receive = (input: Record<string, unknown>) => mail.invoke<Answer>('drive/receive-mail', input);
  return { receive, bytes, ownerBytes, viewerBytes, mail, human, reader };
}

const message = (messageId: string, over: Record<string, unknown> = {}) => ({
  change: 'message', connectionId: CONN, messageId, headerMessageId: `<${messageId}@acme.example>`,
  to: 'mail+drive-abc@in.substrat.run', envelopeFrom: 'me@example.com',
  from: { address: 'billing@acme.example', name: 'Acme' }, replyTo: null,
  recipients: { to: ['me@example.com'], cc: [] }, subject: 'Invoice 1234 from Acme',
  date: '2026-10-26T09:00:00.000Z', inReplyTo: null, references: [], text: 'See attached.', textTruncated: false,
  hasHtml: false, authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
  attachments: [{ index: 0, filename: 'invoice-1234.pdf', contentType: 'application/pdf', size: 4, lands: true }],
  receivedAt: '2026-10-26T09:00:05.000Z', ...over,
});

type Listed = { entries: { id: string; name: string; current_version_id: string | null }[] };
const children = (scope: Awaited<ReturnType<typeof world>>['human'], folderId: string) =>
  scope.invoke<Listed>('drive/list-folder', { folderId });

it('files a message as a folder holding message.eml and each attachment, once', async () => {
  const w = await world();
  const first = await w.receive(message('m1'));
  expect(first).toMatchObject({ entity: { entityType: 'folder' }, raw: true });
  // A redelivery of the message answers the same folder, so its bytes land where they did before.
  expect(await w.receive(message('m1'))).toEqual(first);
  const folder = await w.human.invoke<{ path: string }>('drive/get-folder', { folderId: first.entity!.entityId });
  expect(folder.path).toBe('Mail/2026-10-26 Invoice 1234 from Acme');

  const raw = await w.bytes.upload({ entity: first.entity!, filename: 'message.eml', contentType: 'message/rfc822', visibility: 'internal', body: new TextEncoder().encode('From: billing@acme.example\r\n\r\nSee attached.') });
  const pdf = await w.bytes.upload({ entity: first.entity!, filename: 'invoice-1234.pdf', contentType: 'application/pdf', visibility: 'internal', body: new TextEncoder().encode('%PDF') });
  const pick = (a: typeof raw) => ({ id: a.id, filename: a.filename, contentType: a.contentType, size: a.size, sha256: a.sha256 });
  const rawChange = { change: 'raw', connectionId: CONN, messageId: 'm1', attachment: pick(raw) };
  const pdfChange = { change: 'attachment', connectionId: CONN, messageId: 'm1', index: 0, attachment: pick(pdf) };
  for (const change of [rawChange, pdfChange, rawChange, pdfChange]) expect(await w.receive(change)).toEqual({ ok: true });

  const files = (await children(w.human, first.entity!.entityId)).entries;
  expect(files.map((f) => f.name).sort()).toEqual(['invoice-1234.pdf', 'message.eml']);
  // Each file's bytes open through the ordinary read gate, for anyone who may read the folder.
  const pdfFile = files.find((f) => f.name === 'invoice-1234.pdf')!;
  const got = await w.reader.invoke<{ version: { blob_ref: string; mime: string } }>('drive/get-file', { fileId: pdfFile.id });
  expect(got.version).toMatchObject({ blob_ref: pdf.id, mime: 'application/pdf' });
  const opened = await w.viewerBytes.open(pdf.id);
  expect(new TextDecoder().decode(new Uint8Array(await new Response(opened!.body as BodyInit).arrayBuffer()))).toBe('%PDF');
});

it('keeps two messages with the same subject and day apart', async () => {
  const w = await world();
  const a = await w.receive(message('a'));
  const b = await w.receive(message('b'));
  expect(a.entity!.entityId).not.toBe(b.entity!.entityId);
  const folder = await w.human.invoke<{ path: string }>('drive/get-folder', { folderId: b.entity!.entityId });
  expect(folder.path).toBe('Mail/2026-10-26 Invoice 1234 from Acme (2)');
});

it('names a message folder by its arrival when the Date header did not parse', async () => {
  const w = await world();
  const landed = await w.receive(message('raw-date', { date: 'Mon, 26 Oct 2026 10:00:00 +0100', receivedAt: '2026-10-27T08:00:00.000Z' }));
  const folder = await w.human.invoke<{ path: string }>('drive/get-folder', { folderId: landed.entity!.entityId });
  expect(folder.path).toBe('Mail/2026-10-27 Invoice 1234 from Acme');
});

it('lets only the address land mail, and only bytes stored on the message folder', async () => {
  const w = await world();
  await expect(w.human.invoke('drive/receive-mail', message('x'))).rejects.toThrow();
  const answered = await w.receive(message('m'));
  // A person cannot put bytes on a folder: that write key is the address's alone.
  await expect(w.ownerBytes.upload({ entity: answered.entity!, filename: 'x', contentType: 'text/plain', visibility: 'internal', body: new TextEncoder().encode('x') })).rejects.toThrow();
  const other = await w.receive(message('n', { subject: 'Other' }));
  const stray = await w.bytes.upload({ entity: other.entity!, filename: 'x.pdf', contentType: 'application/pdf', visibility: 'internal', body: new TextEncoder().encode('x') });
  await expect(w.receive({ change: 'attachment', connectionId: CONN, messageId: 'm', index: 0, attachment: { id: stray.id, filename: 'x.pdf', contentType: 'application/pdf', size: 1, sha256: stray.sha256 } }))
    .rejects.toThrow('message folder');
  await expect(w.receive({ change: 'raw', connectionId: CONN, messageId: 'unknown', attachment: { id: stray.id, filename: 'message.eml', contentType: 'message/rfc822', size: 1, sha256: stray.sha256 } }))
    .rejects.toThrow('before their message');
});

it('restores a landed version after someone replaced it, but no other bytes on the folder', async () => {
  const w = await world();
  const first = await w.receive(message('m1'));
  const other = await w.bytes.upload({ entity: first.entity!, filename: 'other.pdf', contentType: 'application/pdf', visibility: 'internal', body: new TextEncoder().encode('other') });
  const pdf = await w.bytes.upload({ entity: first.entity!, filename: 'invoice-1234.pdf', contentType: 'application/pdf', visibility: 'internal', body: new TextEncoder().encode('%PDF') });
  await w.receive({ change: 'attachment', connectionId: CONN, messageId: 'm1', index: 0, attachment: { id: pdf.id, filename: pdf.filename, contentType: pdf.contentType, size: pdf.size, sha256: pdf.sha256 } });
  const file = (await children(w.human, first.entity!.entityId)).entries[0]!;
  const fileRef = { entityType: 'file', entityId: file.id };
  const edit = await w.ownerBytes.upload({ entity: fileRef, filename: file.name, contentType: 'application/pdf', visibility: 'internal', body: new TextEncoder().encode('edited') });
  await w.human.invoke('drive/record-version', { fileId: file.id, location: { source: 'blob', blobRef: edit.id } });
  await w.human.invoke('drive/restore-version', { fileId: file.id, versionId: file.current_version_id });
  const got = await w.human.invoke<{ version: { blob_ref: string } }>('drive/get-file', { fileId: file.id });
  expect(got.version.blob_ref).toBe(pdf.id);
  // Bytes on the same folder that this file never held are still nobody's to name.
  await expect(w.human.invoke('drive/record-version', { fileId: file.id, location: { source: 'blob', blobRef: other.id } })).rejects.toThrow('no attachment');
});

it('refuses new mail while the space mirrors a source, and still answers what already landed', async () => {
  const w = await world();
  const first = await w.receive(message('m1'));
  const pick = (a: { id: string; filename: string; contentType: string; size: number; sha256: string }) => ({ id: a.id, filename: a.filename, contentType: a.contentType, size: a.size, sha256: a.sha256 });
  const landedBytes = await w.bytes.upload({ entity: first.entity!, filename: 'a.pdf', contentType: 'application/pdf', visibility: 'internal', body: new TextEncoder().encode('a') });
  const pendingBytes = await w.bytes.upload({ entity: first.entity!, filename: 'b.pdf', contentType: 'application/pdf', visibility: 'internal', body: new TextEncoder().encode('b') });
  const landed = { change: 'attachment', connectionId: CONN, messageId: 'm1', index: 0, attachment: pick(landedBytes) };
  await w.receive(landed);
  await w.human.invoke('drive/record-source', { provider: 'canopy.a3doc', connectionId: CONN, account: 'ACME', folder: 'Facturas', canUpload: true });
  await expect(w.receive(message('m2'))).rejects.toThrow('connected source');
  await expect(w.receive({ ...landed, index: 1, attachment: pick(pendingBytes) })).rejects.toThrow('connected source');
  expect(await w.receive(message('m1'))).toEqual(first);
  expect(await w.receive(landed)).toEqual({ ok: true });
});

it('names folders and files from untrusted text as one safe segment', () => {
  expect(mailName('Re: a/b\\c\u0007  d', 'x')).toBe('Re: a-b-c d');
  expect(mailName('..', 'fallback')).toBe('fallback');
  expect(mailName('   ', 'fallback')).toBe('fallback');
  expect(mailName('a'.repeat(300), 'x')).toHaveLength(120);
});

it('leaves nothing in a name that can disguise it', () => {
  expect(mailName('invoice\u202Efdp.exe', 'x')).toBe('invoicefdp.exe');
  expect(mailName('a\u200Bb\uFEFFc\u0085d', 'x')).toBe('abc d');
  expect(mailName('\u200B..', 'fallback')).toBe('fallback');
});

it('keeps the extension when a long name is shortened, and whole characters', () => {
  const name = mailName(`${'a'.repeat(130)}.pdf`, 'x');
  expect(name).toHaveLength(120);
  expect(name.endsWith('a.pdf')).toBe(true);
  expect(mailName(`${'a'.repeat(115)}😀😀.pdf`, 'x')).toBe(`${'a'.repeat(115)}.pdf`);
  expect(mailName(`${'a'.repeat(200)}.not an extension`, 'x')).toHaveLength(120);
});

it("never files into a person's own Mail folder, and follows its own when renamed", async () => {
  const w = await world();
  await w.human.invoke('drive/create-folder', { parentId: ROOT_FOLDER_ID, name: 'Mail' });
  const first = await w.receive(message('a'));
  const folder = await w.human.invoke<{ path: string; parent_id: string }>('drive/get-folder', { folderId: first.entity!.entityId });
  expect(folder.path).toBe('Mail (2)/2026-10-26 Invoice 1234 from Acme');
  await w.human.invoke('drive/rename-folder', { folderId: folder.parent_id, name: 'Inbox' });
  const second = await w.receive(message('b', { subject: 'Later' }));
  expect((await w.human.invoke<{ path: string }>('drive/get-folder', { folderId: second.entity!.entityId })).path).toBe('Inbox/2026-10-26 Later');
});
