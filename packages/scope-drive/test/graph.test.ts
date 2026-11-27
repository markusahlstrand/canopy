import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { driveManifest, driveModule, DRIVE_PERM, ROOT_FOLDER_ID } from '../src/index.js';
import { ROLES } from '../src/provision.js';
import type { GraphClaim, GraphExtraction } from '../spec/model.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function world() {
  const dir = mkdtempSync(join(tmpdir(), 'graph-')); dirs.push(dir);
  const host = new SqliteScopeHost({ dir }); host.registerModule(driveModule);
  const staff = platformActorId.parse(ulid()), t = tenantId.parse(ulid()), s = scopeId.parse(ulid());
  const owner = principalId.parse(ulid()), narrow = principalId.parse(ulid());
  await host.admin.createTenant(staff, { id: t, slug: 'graph', name: 'Graph' });
  await host.admin.grantEntitlement(staff, t, driveManifest.entitlementKey as string);
  await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'drive' });
  await host.admin.activateScope(staff, t, s);
  await host.provisionBlobStore(staff, { tenantId: t, vertical: 'drive', binding: 'BLOBS' });
  for (const role of ROLES) await host.admin.defineRole(staff, t, role);
  await host.admin.assignRole(staff, { principalId: owner, roleKey: 'owner', node: { tenantId: t, scopeId: s } });
  const human = await host.getScope(owner, t, s);
  const bytes = await host.attachments(owner, t, s);
  const shared = await human.invoke<{ id: string }>('drive/create-folder', { parentId: ROOT_FOLDER_ID, name: 'Shared' });
  // Reads one folder and nothing else: the reader the visibility rules are for.
  await host.admin.grant(staff, { principalId: narrow, permission: DRIVE_PERM.read, node: { tenantId: t, scopeId: s },
    entity: { entityType: 'folder', entityId: shared.id }, grantedBy: owner });
  const reader = await host.getScope(narrow, t, s);
  const upload = async (name: string, text = 'x', folderId = ROOT_FOLDER_ID) => {
    const file = await human.invoke<{ id: string }>('drive/ensure-file', { folderId, name });
    const a = await bytes.upload({ entity: { entityType: 'file', entityId: file.id }, filename: name, contentType: 'text/plain', visibility: 'internal', body: new TextEncoder().encode(text) });
    const written = await human.invoke<{ current_version_id: string }>('drive/record-version', { fileId: file.id, location: { source: 'blob', blobRef: a.id } });
    return { id: file.id, versionId: written.current_version_id };
  };
  const record = (file: { id: string; versionId: string }, body: Omit<GraphExtraction, 'fileId' | 'versionId' | 'extractedBy'>) =>
    human.invoke<{ suggested: number; corroborated: number; dropped: number; entities: number }>('drive/record-graph-suggestions',
      { fileId: file.id, versionId: file.versionId, extractedBy: 'test-model', ...body });
  const claims = async (fileId: string) => (await human.invoke<{ claims: GraphClaim[] }>('drive/file-graph', { fileId })).claims;
  const decide = (fileId: string, claimIds: string[], decision: 'accept' | 'reject') =>
    human.invoke<{ changed: number; claims: GraphClaim[] }>('drive/decide-graph-claims', { fileId, claimIds, decision });
  return { human, reader, shared, upload, record, claims, decide };
}

const triple = (c: GraphClaim) => {
  const name = (n: GraphClaim['subject']) => (n.kind === 'entity' ? n.entity.name : n.kind === 'document' ? 'doc' : n.display);
  return `${name(c.subject)} ${c.predicate} ${name(c.object)}`;
};

const invoice = {
  validTime: '2026-10-01',
  entities: [
    { ref: 'e1', type: 'Organization', name: 'Acme, S.L.' },
    { ref: 'e2', type: 'Organization', name: 'Canopy AB' },
  ],
  claims: [
    { subject: 'document', predicate: 'provider', object: { ref: 'e1' }, quote: 'Acme, S.L. — Factura', confidence: 0.95 },
    { subject: 'document', predicate: 'customer', object: { ref: 'e2' }, confidence: 0.9 },
    { subject: 'e1', predicate: 'vatID', object: { value: 'ES B-58818501' }, confidence: 0.9 },
    { subject: 'e1', predicate: 'es:nif', object: { value: 'B58818501' }, confidence: 0.9 },
    { subject: 'document', predicate: 'totalPaymentDue', object: { value: '1210,00 EUR' }, confidence: 0.8 },
    // Not in the vocabulary, a wrong subject, a misread checksum: all dropped.
    { subject: 'e1', predicate: 'ceoOf', object: { ref: 'e2' } },
    { subject: 'e2', predicate: 'paymentDueDate', object: { value: '2026-11-01' } },
    { subject: 'e2', predicate: 'iban', object: { value: 'ES91 2100 0418 4502 0005 1333' } },
  ],
};

describe('graph suggestions', () => {
  it('records what fits the vocabulary as suggestions and drops the rest', async () => {
    const w = await world();
    const file = await w.upload('factura.pdf');
    const result = await w.record(file, invoice);
    expect(result).toMatchObject({ suggested: 5, corroborated: 0, dropped: 3, entities: 2 });
    const list = await w.claims(file.id);
    expect(list.map(triple).sort()).toEqual([
      'Acme, S.L. es:nif B58818501',
      'Acme, S.L. vatID ESB58818501',
      'doc customer Canopy AB',
      'doc provider Acme, S.L.',
      'doc totalPaymentDue 1210.00 EUR',
    ]);
    expect(list.every((c) => c.status === 'suggested' && c.validTime === '2026-10-01')).toBe(true);
    expect(list.find((c) => c.predicate === 'provider')).toMatchObject({ quote: 'Acme, S.L. — Factura', confidence: 0.95, extractedBy: 'test-model' });
  });

  it('refuses a reading of a version that is no longer current', async () => {
    const w = await world();
    const file = await w.upload('a.pdf');
    await w.upload('a.pdf', 'newer');
    await expect(w.record(file, invoice)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('matches an entity by its VAT id across documents, and by name otherwise', async () => {
    const w = await world();
    const a = await w.upload('a.pdf'), b = await w.upload('b.pdf');
    await w.record(a, invoice);
    const second = await w.record(b, {
      entities: [{ ref: 'x', type: 'Organization', name: 'ACME Servicios' }, { ref: 'y', type: 'Organization', name: 'canopy ab' }],
      claims: [
        { subject: 'x', predicate: 'vatID', object: { value: 'ESB58818501' } },
        { subject: 'document', predicate: 'provider', object: { ref: 'x' } },
        { subject: 'document', predicate: 'customer', object: { ref: 'y' } },
      ],
    });
    expect(second.entities).toBe(0);
    const ids = (await w.claims(b.id)).flatMap((c) => (c.object.kind === 'entity' ? [c.object.entity.name] : []));
    expect(ids.sort()).toEqual(['Acme, S.L.', 'Canopy AB']);
  });

  it('adds a mention for an entity the document names without a stronger tie', async () => {
    const w = await world();
    const file = await w.upload('minutes.pdf');
    await w.record(file, {
      entities: [{ ref: 'p', type: 'Person', name: 'Ana López' }, { ref: 'o', type: 'Organization', name: 'Acme' }],
      claims: [{ subject: 'p', predicate: 'worksFor', object: { ref: 'o' }, confidence: 0.7 }],
    });
    expect((await w.claims(file.id)).map(triple).sort()).toEqual([
      'Ana López worksFor Acme', 'doc mentions Acme', 'doc mentions Ana López',
    ]);
  });

  it('accepting makes facts and real entities; the same statement elsewhere is corroboration, not a question', async () => {
    const w = await world();
    const a = await w.upload('a.pdf'), b = await w.upload('b.pdf');
    await w.record(a, invoice);
    const vat = (await w.claims(a.id)).find((c) => c.predicate === 'vatID')!;
    const accepted = await w.decide(a.id, [vat.id], 'accept');
    expect(accepted.changed).toBe(1);
    const after = accepted.claims.find((c) => c.id === vat.id)!;
    expect(after.status).toBe('accepted');
    expect(after.subject.kind === 'entity' && after.subject.entity.status).toBe('accepted');

    const again = await w.record(b, { entities: [{ ref: 'x', type: 'Organization', name: 'Acme' }], claims: [{ subject: 'x', predicate: 'vatID', object: { value: 'ESB58818501' } }] });
    expect(again).toMatchObject({ corroborated: 1 });
    expect((await w.claims(b.id)).find((c) => c.predicate === 'vatID')).toMatchObject({ status: 'accepted', decidedBy: 'auto:corroborates' });
  });

  it('does not ask again about a statement someone rejected', async () => {
    const w = await world();
    const a = await w.upload('a.pdf'), b = await w.upload('b.pdf');
    await w.record(a, invoice);
    const nif = (await w.claims(a.id)).find((c) => c.predicate === 'es:nif')!;
    await w.decide(a.id, [nif.id], 'reject');
    await w.record(b, { entities: [{ ref: 'x', type: 'Organization', name: 'Acme' }], claims: [{ subject: 'x', predicate: 'es:nif', object: { value: 'B58818501' } }] });
    expect((await w.claims(b.id)).find((c) => c.predicate === 'es:nif')).toMatchObject({ status: 'rejected', decidedBy: 'auto:rejected-before' });
  });

  it('a newer one-value claim says what it replaces, and supersedes it once accepted', async () => {
    const w = await world();
    const a = await w.upload('a.pdf'), b = await w.upload('b.pdf');
    const person = (address: string) => ({ entities: [{ ref: 'p', type: 'Person', name: 'Ana López' }], claims: [{ subject: 'p', predicate: 'address', object: { value: address } }] });
    await w.record(a, person('Calle Mayor 1, Madrid'));
    const old = (await w.claims(a.id)).find((c) => c.predicate === 'address')!;
    await w.decide(a.id, [old.id], 'accept');
    await w.record(b, person('Gran Vía 2, Madrid'));
    const fresh = (await w.claims(b.id)).find((c) => c.predicate === 'address')!;
    expect(fresh.replaces).toEqual(['Calle Mayor 1, Madrid']);
    await w.decide(b.id, [fresh.id], 'accept');
    // History, not deleted: no longer listed with the file's live claims.
    expect((await w.claims(a.id)).find((c) => c.id === old.id)).toBeUndefined();
  });

  it('a new version supersedes the open suggestions of the old one and keeps decisions', async () => {
    const w = await world();
    const v1 = await w.upload('a.pdf');
    await w.record(v1, invoice);
    const first = await w.claims(v1.id);
    const provider = first.find((c) => c.predicate === 'provider')!;
    await w.decide(v1.id, [provider.id], 'accept');
    const v2 = await w.upload('a.pdf', 'v2');
    await w.record(v2, { entities: [{ ref: 'e', type: 'Person', name: 'Bo' }], claims: [] });
    const now = await w.claims(v1.id);
    expect(now.filter((c) => c.status === 'suggested').map(triple)).toEqual(['doc mentions Bo']);
    expect(now.find((c) => c.id === provider.id)?.status).toBe('accepted');
  });

  it('lists open suggestions surest first, only from live files; a folder guest cannot ask', async () => {
    const w = await world();
    const gone = await w.upload('gone.pdf');
    const open = await w.upload('open.pdf', 'x', w.shared.id);
    await w.record(gone, { entities: [{ ref: 'a', type: 'Organization', name: 'Hidden Co' }], claims: [{ subject: 'document', predicate: 'provider', object: { ref: 'a' }, confidence: 0.99 }] });
    await w.record(open, {
      entities: [{ ref: 'b', type: 'Organization', name: 'Visible Co' }],
      claims: [{ subject: 'document', predicate: 'provider', object: { ref: 'b' }, confidence: 0.6 }, { subject: 'b', predicate: 'email', object: { value: 'hi@visible.co' }, confidence: 0.8 }],
    });
    const list = async () => (await w.human.invoke<{ claims: GraphClaim[] }>('drive/graph-suggestions', {})).claims;
    expect((await list()).map((c) => c.confidence)).toEqual([0.99, 0.8, 0.6]);
    await w.human.invoke('drive/trash-file', { fileId: gone.id });
    expect((await list()).map(triple)).toEqual(['Visible Co email hi@visible.co', 'doc provider Visible Co']);
    // Like search: asking across the space takes membership, not one shared folder.
    await expect(w.reader.invoke('drive/graph-suggestions', {})).rejects.toMatchObject({ code: 'permission_denied' });
    // The file it can read, it can read the graph of.
    expect((await w.reader.invoke<{ claims: GraphClaim[]; canWrite: boolean }>('drive/file-graph', { fileId: open.id })).canWrite).toBe(false);
  });

  it('an entity shows what live documents say about it and what it connects to through them', async () => {
    const w = await world();
    const inv = await w.upload('invoice.pdf');
    const memo = await w.upload('memo.pdf');
    await w.record(inv, invoice);
    await w.record(memo, {
      entities: [{ ref: 'p', type: 'Person', name: 'Ana López' }, { ref: 'o', type: 'Organization', name: 'Acme SL' }],
      claims: [{ subject: 'p', predicate: 'worksFor', object: { ref: 'o' } }],
    });
    await w.decide(inv.id, (await w.claims(inv.id)).map((c) => c.id), 'accept');
    await w.decide(memo.id, (await w.claims(memo.id)).map((c) => c.id), 'accept');
    const provider = (await w.claims(inv.id)).find((c) => c.predicate === 'provider')!;
    const acmeId = provider.object.kind === 'entity' ? provider.object.entity.id : '';
    const worksFor = (await w.claims(memo.id)).find((c) => c.predicate === 'worksFor')!;
    const anaId = worksFor.subject.kind === 'entity' ? worksFor.subject.entity.id : '';
    type View = { claims: GraphClaim[]; connections: { entity: { name: string }; depth: number; via: string[] }[] };
    const view = (entityId: string) => w.human.invoke<View>('drive/graph-entity', { entityId });

    const full = await view(acmeId);
    // Ana works there; Canopy AB is two hops away, through the invoice Acme issued to it.
    expect(full.connections.map((c) => [c.entity.name, c.depth, c.via])).toEqual([['Ana López', 1, ['worksFor']], ['Canopy AB', 2, ['provider', 'customer']]]);

    // A trashed memo takes what it said with it.
    await w.human.invoke('drive/trash-file', { fileId: memo.id });
    const after = await view(acmeId);
    expect(after.connections.map((c) => c.entity.name)).toEqual(['Canopy AB']);
    expect(after.claims.every((c) => c.fileId === inv.id)).toBe(true);
    await expect(view(anaId)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('merging entities', () => {
  type Summary = { entity: { id: string; name: string; type: string; status: string }; documents: number };
  type View = { entity: { id: string; name: string; status: string }; claims: GraphClaim[] };
  type Merged = { entity: { id: string; name: string; status: string }; merged: number; moved: number; superseded: number };
  const org = (ref: string, name: string) => ({ ref, type: 'Organization', name });

  async function setup() {
    const w = await world();
    const list = async () => (await w.human.invoke<{ entities: Summary[]; canMerge: boolean }>('drive/graph-entities', {}));
    const idOf = async (name: string) => (await list()).entities.find((e) => e.entity.name === name)!.entity.id;
    const view = (entityId: string) => w.human.invoke<View>('drive/graph-entity', { entityId });
    const merge = (entityId: string, mergeIds: string[]) => w.human.invoke<Merged>('drive/merge-graph-entities', { entityId, mergeIds });
    const acceptAll = async (fileId: string) => w.decide(fileId, (await w.claims(fileId)).filter((c) => c.status === 'suggested').map((c) => c.id), 'accept');
    return { ...w, list, idOf, view, merge, acceptAll };
  }

  it('lists the entities the caller’s documents name, with how many documents', async () => {
    const w = await setup();
    const a = await w.upload('a.pdf'), b = await w.upload('b.pdf');
    await w.record(a, invoice);
    await w.record(b, { entities: [org('x', 'Acme, S.L.')], claims: [{ subject: 'document', predicate: 'provider', object: { ref: 'x' } }] });
    const got = await w.list();
    expect(got.canMerge).toBe(true);
    expect(got.entities.map((e) => [e.entity.name, e.documents])).toEqual([['Acme, S.L.', 2], ['Canopy AB', 1]]);
    // Like suggestions: a folder guest cannot list the space.
    await expect(w.reader.invoke('drive/graph-entities', {})).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('moves everything said about the merged entity, and its name finds the one kept from then on', async () => {
    const w = await setup();
    const a = await w.upload('a.pdf'), b = await w.upload('b.pdf');
    await w.record(a, invoice);
    await w.acceptAll(a.id);
    await w.record(b, {
      entities: [org('x', 'ACME Servicios'), { ref: 'p', type: 'Person', name: 'Ana López' }],
      claims: [{ subject: 'document', predicate: 'customer', object: { ref: 'x' } }, { subject: 'p', predicate: 'worksFor', object: { ref: 'x' } }],
    });
    const acme = await w.idOf('Acme, S.L.'), servicios = await w.idOf('ACME Servicios');
    const result = await w.merge(acme, [servicios]);
    expect(result).toMatchObject({ entity: { id: acme, name: 'Acme, S.L.', status: 'accepted' }, merged: 1, moved: 2, superseded: 0 });

    expect((await w.list()).entities.map((e) => e.entity.name)).toEqual(['Acme, S.L.', 'Canopy AB', 'Ana López']);
    expect((await w.claims(b.id)).map(triple).sort()).toEqual(['Ana López worksFor Acme, S.L.', 'doc customer Acme, S.L.', 'doc mentions Ana López']);
    // An old link lands on the one kept.
    expect((await w.view(servicios)).entity.id).toBe(acme);

    // The next document naming the merged one does not bring the duplicate back.
    const c = await w.upload('c.pdf');
    const again = await w.record(c, { entities: [org('y', 'Acme Servicios')], claims: [{ subject: 'document', predicate: 'provider', object: { ref: 'y' } }] });
    expect(again.entities).toBe(0);
    expect((await w.claims(c.id)).map(triple)).toEqual(['doc provider Acme, S.L.']);
  });

  it('settles what the merge made odd: an entity related to itself, a statement twice, a question already answered', async () => {
    const w = await setup();
    const a = await w.upload('a.pdf'), b = await w.upload('b.pdf');
    await w.record(a, { entities: [org('o', 'Acme')], claims: [{ subject: 'o', predicate: 'telephone', object: { value: '+34 600 123 456' } }] });
    await w.acceptAll(a.id);
    await w.record(b, {
      entities: [org('g', 'Acme Group'), org('o', 'Acme')],
      claims: [
        { subject: 'o', predicate: 'parentOrganization', object: { ref: 'g' } },
        { subject: 'g', predicate: 'telephone', object: { value: '+34 600 123 456' } },
      ],
    });
    const acme = await w.idOf('Acme'), group = await w.idOf('Acme Group');
    const result = await w.merge(acme, [group]);
    // "Acme is part of Acme", and b's two mentions now name one entity.
    expect(result.superseded).toBe(2);
    const now = await w.claims(b.id);
    expect(now.map(triple).sort()).toEqual(['Acme telephone +34600123456', 'doc mentions Acme']);
    // The same phone was already accepted from a: corroboration, not a question.
    expect(now.find((c) => c.predicate === 'telephone')).toMatchObject({ status: 'accepted', decidedBy: 'auto:corroborates' });
  });

  it('keeps the latest of two accepted one-value facts, the other as history', async () => {
    const w = await setup();
    const a = await w.upload('a.pdf'), b = await w.upload('b.pdf');
    await w.record(a, { validTime: '2026-01-01', entities: [org('o', 'Acme')], claims: [{ subject: 'o', predicate: 'address', object: { value: 'Calle Mayor 1, Madrid' } }] });
    await w.record(b, { validTime: '2026-06-01', entities: [org('o', 'Acme Iberia')], claims: [{ subject: 'o', predicate: 'address', object: { value: 'Gran Vía 2, Madrid' } }] });
    await w.acceptAll(a.id); await w.acceptAll(b.id);
    const acme = await w.idOf('Acme');
    await w.merge(acme, [await w.idOf('Acme Iberia')]);
    const facts = (await w.view(acme)).claims.filter((c) => c.predicate === 'address');
    expect(facts.map((c) => [c.object.kind === 'value' && c.object.display, c.status])).toEqual([['Gran Vía 2, Madrid', 'accepted']]);
  });

  it('refuses two accepted VAT numbers, two kinds, nothing to merge, and a caller who cannot write the space', async () => {
    const w = await setup();
    const a = await w.upload('a.pdf'), b = await w.upload('b.pdf', 'x', w.shared.id);
    await w.record(a, { entities: [org('o', 'Acme'), { ref: 'p', type: 'Person', name: 'Ana López' }], claims: [{ subject: 'o', predicate: 'vatID', object: { value: 'ESB58818501' } }] });
    await w.record(b, { entities: [org('o', 'Acme Iberia')], claims: [{ subject: 'o', predicate: 'vatID', object: { value: 'ESA58818501' } }] });
    const acme = await w.idOf('Acme'), iberia = await w.idOf('Acme Iberia'), ana = await w.idOf('Ana López');

    // Two VAT numbers someone accepted are two companies.
    await w.acceptAll(a.id); await w.acceptAll(b.id);
    await expect(w.merge(acme, [iberia])).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('have different VAT number') });
    await expect(w.merge(acme, [ana])).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(w.merge(acme, [acme])).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(w.merge(acme, ['nope'])).rejects.toMatchObject({ code: 'not_found' });
    await expect(w.reader.invoke('drive/merge-graph-entities', { entityId: iberia, mergeIds: [acme] })).rejects.toMatchObject({ code: 'permission_denied' });
    // Refused means untouched.
    expect((await w.list()).entities).toHaveLength(3);
  });
});
