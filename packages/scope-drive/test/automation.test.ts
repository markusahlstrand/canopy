import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { driveManifest, driveModule, DRIVE_PERM, ROOT_FOLDER_ID } from '../src/index.js';
import { ROLES } from '../src/provision.js';
import {
  conditionHolds, flowDefinition, flowMatches, globMatches, scheduleDue,
  type AutomationItem, type FileFactsRow, type FlowDelivery, type StoredFlow,
} from '../spec/model.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function world() {
  const dir = mkdtempSync(join(tmpdir(), 'automation-')); dirs.push(dir);
  const host = new SqliteScopeHost({ dir }); host.registerModule(driveModule);
  const staff = platformActorId.parse(ulid()), t = tenantId.parse(ulid()), s = scopeId.parse(ulid());
  const owner = principalId.parse(ulid()), source = principalId.parse(ulid()), editor = principalId.parse(ulid());
  await host.admin.createTenant(staff, { id: t, slug: 'auto', name: 'Auto' });
  await host.admin.grantEntitlement(staff, t, driveManifest.entitlementKey as string);
  await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'drive' });
  await host.admin.activateScope(staff, t, s);
  await host.provisionBlobStore(staff, { tenantId: t, vertical: 'drive', binding: 'BLOBS' });
  for (const role of ROLES) await host.admin.defineRole(staff, t, role);
  for (const p of [owner, source]) await host.admin.assignRole(staff, { principalId: p, roleKey: 'owner', node: { tenantId: t, scopeId: s } });
  await host.admin.assignRole(staff, { principalId: editor, roleKey: 'editor', node: { tenantId: t, scopeId: s } });
  await host.admin.grant(staff, { principalId: source, permission: DRIVE_PERM.landSource, node: { tenantId: t, scopeId: s }, grantedBy: source });
  const human = await host.getScope(owner, t, s), member = await host.getScope(editor, t, s), connector = await host.getScope(source, t, s);
  const bytes = await host.attachments(owner, t, s), connectorBytes = await host.attachments(source, t, s);
  const upload = async (name: string, text: string, folderId = ROOT_FOLDER_ID) => {
    const file = await human.invoke<{ id: string }>('drive/ensure-file', { folderId, name });
    const a = await bytes.upload({ entity: { entityType: 'file', entityId: file.id }, filename: name, contentType: 'text/plain', visibility: 'internal', body: new TextEncoder().encode(text) });
    const written = await human.invoke<{ id: string; current_version_id: string }>('drive/record-version', { fileId: file.id, location: { source: 'blob', blobRef: a.id } });
    return { id: file.id, versionId: written.current_version_id };
  };
  const claim = async () => (await human.invoke<{ items: AutomationItem[] }>('drive/automation-claim', {})).items;
  const emitted = async (type: string) => (await host.admin.queryScope(staff, t, s, { sql: `SELECT COUNT(*) FROM _substrat_outbox WHERE type = '${type}'` })).rows[0]![0];
  const lastPayload = async (type: string) => JSON.parse(String((await host.admin.queryScope(staff, t, s, { sql: `SELECT payload FROM _substrat_outbox WHERE type = '${type}' ORDER BY id DESC LIMIT 1` })).rows[0]![0])) as Record<string, unknown>;
  return { host, human, member, connector, bytes, connectorBytes, upload, claim, emitted, lastPayload, owner, t, s };
}

const definition = flowDefinition.parse({
  trigger: { on: 'arrived' },
  conditions: [{ field: 'folder', op: 'under', path: 'Statements' }],
  actions: [{ type: 'copy', space: 'other', folderId: 'f1' }],
});

describe('the automation queue', () => {
  it('queues each uploaded version with the person who wrote it, and drains in order', async () => {
    const w = await world();
    const a = await w.upload('a.txt', 'one');
    const b = await w.upload('b.txt', 'two');
    const items = await w.claim();
    expect(items.map((i) => [i.fileId, i.versionId, i.trigger, i.actor])).toEqual([
      [a.id, a.versionId, 'arrived', w.owner],
      [b.id, b.versionId, 'arrived', w.owner],
    ]);
    expect(items[0]!.file).toMatchObject({ name: 'a.txt', folderPath: '', versionId: a.versionId, copiedByFlow: false });
    expect(await w.human.invoke('drive/automation-pending')).toEqual({ queued: 2, dueSchedules: 0 });
    expect(await w.human.invoke('drive/automation-ack', { upTo: items[0]!.seq })).toEqual({ dropped: 1 });
    expect((await w.claim()).map((i) => i.fileId)).toEqual([b.id]);
  });

  it('queues a version a connector syncs in, with no person behind it', async () => {
    const w = await world();
    const upsert = { connectionId: 'c', itemId: 'tx-1', kind: 'file' as const, path: 'Statement.pdf', name: 'Statement.pdf', change: 'upsert' as const,
      previousPath: null, size: 3, contentType: 'application/pdf', lastModifiedAt: null, webUrl: null, content: 'follows' as const };
    const landed = await w.connector.invoke<{ entity: { entityType: string; entityId: string } }>('drive/land-source-change', upsert);
    const att = await w.connectorBytes.upload({ entity: landed.entity, filename: 'Statement.pdf', contentType: 'application/pdf', visibility: 'internal', body: new Uint8Array([1, 2, 3]) });
    await w.connector.invoke('drive/land-source-change', { ...upsert, change: 'content', attachment: att, replaces: null });
    const items = await w.claim();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ fileId: landed.entity.entityId, trigger: 'arrived', actor: null });
  });

  it('is only for managers', async () => {
    const w = await world();
    await expect(w.member.invoke('drive/automation-claim', {})).rejects.toThrow();
    await expect(w.member.invoke('drive/list-flows')).rejects.toThrow();
  });
});

describe('categories', () => {
  it('lets a person overrule the AI, and never the other way round', async () => {
    const w = await world();
    const a = await w.upload('a.txt', 'one');
    await w.human.invoke('drive/automation-ack', { upTo: 1_000 });
    const ai = await w.human.invoke<{ changed: boolean }>('drive/set-file-category', { fileId: a.id, category: 'bank-statement', source: 'ai', confidence: 0.9, expectedVersionId: a.versionId });
    expect(ai.changed).toBe(true);
    expect((await w.claim()).map((i) => i.trigger)).toEqual(['classified']);
    // The same answer again is no change, and queues nothing.
    expect((await w.human.invoke<{ changed: boolean }>('drive/set-file-category', { fileId: a.id, category: 'bank-statement', source: 'ai', confidence: 0.9 })).changed).toBe(false);
    await w.human.invoke('drive/set-file-category', { fileId: a.id, category: 'invoice', source: 'person' });
    const after = await w.human.invoke<{ changed: boolean }>('drive/set-file-category', { fileId: a.id, category: 'receipt', source: 'ai', confidence: 1 });
    expect(after.changed).toBe(false);
    const details = await w.human.invoke<{ category: { id: string; source: string; confidence: number | null } }>('drive/file-details', { fileId: a.id });
    expect(details.category).toMatchObject({ id: 'invoice', source: 'person', confidence: null });
    // Clearing hands the file back to the AI.
    await w.human.invoke('drive/set-file-category', { fileId: a.id, category: null, source: 'person' });
    expect((await w.human.invoke<{ changed: boolean }>('drive/set-file-category', { fileId: a.id, category: 'receipt', source: 'ai', confidence: 1 })).changed).toBe(true);
    expect(await w.emitted('drive.file-classified')).toBe(4);
  });

  it('refuses an AI answer about a version that has been replaced', async () => {
    const w = await world();
    const a = await w.upload('a.txt', 'one');
    await expect(w.human.invoke('drive/set-file-category', { fileId: a.id, category: 'x', source: 'ai', confidence: 1, expectedVersionId: 'old' })).rejects.toThrow('older version');
  });
});

describe('flows', () => {
  it('saves, lists, replaces and deletes a flow; the author login stays off the public read', async () => {
    const w = await world();
    const saved = await w.human.invoke<StoredFlow>('drive/save-flow', { name: 'Statements', enabled: true, definition, authorSub: 'sub-1' });
    expect(saved).toMatchObject({ name: 'Statements', enabled: true, author: w.owner, failures: 0, pausedReason: null });
    expect(saved).not.toHaveProperty('authorSub');
    const listed = await w.human.invoke<{ flows: StoredFlow[] }>('drive/list-flows');
    expect(listed.flows.map((f) => f.id)).toEqual([saved.id]);
    const inner = await w.human.invoke<{ flows: (StoredFlow & { authorSub: string })[] }>('drive/automation-flows');
    expect(inner.flows[0]!.authorSub).toBe('sub-1');
    await w.human.invoke('drive/save-flow', { id: saved.id, name: 'Renamed', enabled: false, definition, authorSub: 'sub-2' });
    expect((await w.human.invoke<{ flows: StoredFlow[] }>('drive/list-flows')).flows[0]).toMatchObject({ name: 'Renamed', enabled: false });
    await w.human.invoke('drive/delete-flow', { id: saved.id });
    expect((await w.human.invoke<{ flows: StoredFlow[] }>('drive/list-flows')).flows).toEqual([]);
  });

  it('moves a delivery only from the states it expects, and pauses a flow that keeps failing', async () => {
    const w = await world();
    const flow = await w.human.invoke<StoredFlow>('drive/save-flow', { name: 'F', enabled: true, definition, authorSub: 'sub' });
    const a = await w.upload('a.txt', 'one');
    type Recorded = { delivery: FlowDelivery | null; changed: boolean; previous: string };
    const record = (state: string, expect?: string[], detail?: Record<string, unknown>) =>
      w.human.invoke<Recorded>('drive/record-flow-delivery', { flowId: flow.id, fileId: a.id, versionId: a.versionId, state, ...(expect ? { expect } : {}), ...(detail ? { detail } : {}) });
    expect((await record('proposed', ['none'])).changed).toBe(true);
    expect((await record('proposed', ['none'])).changed).toBe(false);
    const approved = await record('approved', ['proposed']);
    expect(approved).toMatchObject({ changed: true, previous: 'proposed', delivery: { state: 'approved', fileName: 'a.txt' } });
    expect((await record('approved', ['proposed'])).changed).toBe(false);
    expect((await record('running', ['approved'])).delivery!.attempts).toBe(1);
    for (let i = 0; i < 5; i++) await record('failed', undefined, { error: `boom ${i}` });
    const [paused] = (await w.human.invoke<{ flows: StoredFlow[] }>('drive/list-flows')).flows;
    expect(paused!.failures).toBe(5);
    expect(paused!.pausedReason).toContain('boom 4');
    const deliveries = await w.human.invoke<{ deliveries: FlowDelivery[] }>('drive/flow-deliveries', { flowId: flow.id });
    expect(deliveries.deliveries).toHaveLength(1);
    // Saving again is taking it on: it starts over unpaused.
    await w.human.invoke('drive/save-flow', { id: flow.id, name: 'F', enabled: true, definition, authorSub: 'sub' });
    expect((await w.human.invoke<{ flows: StoredFlow[] }>('drive/list-flows')).flows[0]).toMatchObject({ failures: 0, pausedReason: null });
  });

  it('counts a scheduled flow as due until it has run, and lists candidates after a time', async () => {
    const w = await world();
    const scheduled = flowDefinition.parse({ ...definition, trigger: { on: 'schedule', every: 'day' } });
    const flow = await w.human.invoke<StoredFlow>('drive/save-flow', { name: 'Daily', enabled: true, definition: scheduled, authorSub: 'sub' });
    const a = await w.upload('a.txt', 'one');
    expect((await w.human.invoke<{ dueSchedules: number }>('drive/automation-pending')).dueSchedules).toBe(1);
    await w.human.invoke('drive/flow-ran', { flowId: flow.id, at: new Date().toISOString() });
    expect((await w.human.invoke<{ dueSchedules: number }>('drive/automation-pending')).dueSchedules).toBe(0);
    const all = await w.human.invoke<{ files: FileFactsRow[] }>('drive/flow-candidates', { since: null });
    expect(all.files.map((f) => f.fileId)).toEqual([a.id]);
    const later = await w.human.invoke<{ files: FileFactsRow[] }>('drive/flow-candidates', { since: new Date(Date.now() + 60_000).toISOString() });
    expect(later.files).toEqual([]);
  });

  it('marks a file a flow copied in, so it is known as a copy', async () => {
    const w = await world();
    const file = await w.human.invoke<{ id: string }>('drive/ensure-file', { folderId: ROOT_FOLDER_ID, name: 'copy.txt' });
    await w.human.invoke('drive/record-file-origin', { fileId: file.id, flowId: 'f', sourceScope: 's', sourceFileId: 'x', sourceVersionId: 'v' });
    const att = await w.bytes.upload({ entity: { entityType: 'file', entityId: file.id }, filename: 'copy.txt', contentType: 'text/plain', visibility: 'internal', body: new TextEncoder().encode('x') });
    await w.human.invoke('drive/record-version', { fileId: file.id, location: { source: 'blob', blobRef: att.id } });
    const [item] = await w.claim();
    expect(item!.file!.copiedByFlow).toBe(true);
    expect((await w.human.invoke<{ origin: { flowId: string } }>('drive/file-details', { fileId: file.id })).origin).toMatchObject({ flowId: 'f', sourceFileId: 'x' });
  });
});

describe('a3doc send failures', () => {
  it('shows the failure on the file, and a retry carries the failed request and its categories', async () => {
    const w = await world();
    const fiscal = await w.human.invoke<{ id: string }>('drive/create-folder', { parentId: ROOT_FOLDER_ID, name: 'Fiscal' });
    const a = await w.upload('Recibo.txt', 'one');
    await w.human.invoke('drive/record-source', { provider: 'canopy.a3doc', connectionId: 'c', account: 'ACME', folder: 'F', canUpload: true });
    await w.human.invoke('drive/send-source-file', { fileId: a.id, alsoIn: [fiscal.id] });
    await expect(w.human.invoke('drive/retry-source-send', { fileId: a.id })).rejects.toThrow('still being sent');
    expect((await w.human.invoke<{ send: unknown }>('drive/file-details', { fileId: a.id })).send).toMatchObject({ state: 'sending', error: null });
    await w.connector.invoke('drive/source-write-journal', { key: `a3doc:failed:${a.id}`, value: { error: 'a3doc said no', eventId: 'evt-1' } });
    expect((await w.human.invoke<{ send: unknown }>('drive/file-details', { fileId: a.id })).send).toMatchObject({ state: 'failed', error: 'a3doc said no', attempts: 1 });
    const retried = await w.human.invoke('drive/retry-source-send', { fileId: a.id });
    expect(retried).toMatchObject({ retryOf: 'evt-1', alsoIn: ['Fiscal'] });
    expect(await w.emitted('a3doc.files-requested')).toBe(2);
    expect(await w.lastPayload('a3doc.files-requested')).toMatchObject({ retryOf: 'evt-1', alsoIn: ['Fiscal'] });
    expect((await w.human.invoke<{ send: unknown }>('drive/file-details', { fileId: a.id })).send).toMatchObject({ state: 'sending' });
  });

  it('lets only the connector record a failure', async () => {
    const w = await world();
    await expect(w.member.invoke('drive/source-write-journal', { key: 'a3doc:failed:x', value: { error: 'e' } })).rejects.toThrow();
  });
});

describe('matching', () => {
  const facts = { name: 'Statement 2026-10.PDF', folderPath: 'Statements/2026', labels: ['Bank'], category: { id: 'bank-statement', confidence: 0.8, source: 'ai' as const } };
  it('checks each kind of condition', () => {
    expect(conditionHolds({ field: 'folder', op: 'under', path: 'Statements' }, facts)).toBe(true);
    expect(conditionHolds({ field: 'folder', op: 'is', path: 'Statements' }, facts)).toBe(false);
    expect(conditionHolds({ field: 'folder', op: 'under', path: 'State' }, facts)).toBe(false);
    expect(conditionHolds({ field: 'folder', op: 'under', path: '' }, facts)).toBe(true);
    expect(conditionHolds({ field: 'name', op: 'contains', value: 'statement' }, facts)).toBe(true);
    expect(conditionHolds({ field: 'name', op: 'matches', value: 'Statement *.pdf' }, facts)).toBe(true);
    expect(conditionHolds({ field: 'extension', values: ['.pdf'] }, facts)).toBe(true);
    expect(conditionHolds({ field: 'label', value: 'bank' }, facts)).toBe(true);
    expect(conditionHolds({ field: 'category', values: ['bank-statement'], minConfidence: 0.9 }, facts)).toBe(false);
    expect(conditionHolds({ field: 'category', values: ['bank-statement'], minConfidence: 0.7 }, facts)).toBe(true);
    expect(conditionHolds({ field: 'category', values: ['bank-statement'], minConfidence: 0.99 }, { ...facts, category: { id: 'bank-statement', confidence: null, source: 'person' } })).toBe(true);
    expect(conditionHolds({ field: 'ask', question: 'Is it?' }, facts)).toBe('ask');
  });
  it('fails fast on a plain condition, and leaves questions to the runner', () => {
    expect(flowMatches({ conditions: [{ field: 'ask', question: 'Is it?' }, { field: 'label', value: 'nope' }] }, facts)).toBe(false);
    expect(flowMatches({ conditions: [{ field: 'ask', question: 'Is it?' }, { field: 'label', value: 'bank' }] }, facts)).toBe('ask');
    expect(flowMatches({ conditions: [] }, facts)).toBe(true);
  });
  it('treats a pattern as literal except for * and ?', () => {
    expect(globMatches('a.b(1)*', 'A.B(1) copy')).toBe(true);
    expect(globMatches('a.b', 'axb')).toBe(false);
  });
  it('is due when never run or when the period has passed', () => {
    const now = Date.parse('2026-11-12T10:00:00Z');
    expect(scheduleDue({ on: 'schedule', every: 'day' }, null, now)).toBe(true);
    expect(scheduleDue({ on: 'schedule', every: 'day' }, '2026-11-12T00:00:00Z', now)).toBe(false);
    expect(scheduleDue({ on: 'schedule', every: 'hour' }, '2026-11-12T08:59:00Z', now)).toBe(true);
    expect(scheduleDue({ on: 'arrived' }, null, now)).toBe(false);
  });
});
