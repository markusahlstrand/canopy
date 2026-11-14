/**
 * Automation as real kernel jobs across two spaces of one tenant: a source space (think Qonto)
 * whose flows copy into a target space (think a3doc). Registered on a host, kicked and driven by
 * `runDueJobs` exactly as the worker and the sweeper drive them. Only the model is fake.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { defaultAttachmentExtractors } from '@substrat-run/attachment-extractors';
import { moduleId, platformActorId, principalId, scopeId, tenantId, type PrincipalId, type ScopeId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import type { ModelHost } from '@substrat-run/vertical-host/model';
import { ROOT_FOLDER_ID, driveManifest, driveModule } from '@canopy/scope-drive';
import { ROLES } from '@canopy/scope-drive/provision';
import { flowDefinition, type FlowDelivery, type FlowDefinition, type StoredFlow } from '@canopy/scope-drive/spec/model';
import { AUTO_LABEL_JOB, autoLabelJob, type AutoLabelPayload } from '../src/document-ai';
import {
  AUTOMATION_JOB, automationJob, DISPATCH_INSTANCE, FLOW_BACKFILL_JOB, flowBackfillJob, FLOW_RUN_JOB, flowRunJob, parseAnswer,
  type AutomationDeps, type Node,
} from '../src/automation';

let dir: string;
let host: SqliteScopeHost;
const staff = platformActorId.parse(ulid());
const tenant = tenantId.parse(ulid());
const source = scopeId.parse(ulid()), target = scopeId.parse(ulid()), elsewhere = scopeId.parse(ulid());
const DRIVE = moduleId.parse(driveManifest.id);
/** Ada is one login: a different principal in each space, as K-22 has it. */
const ada = { [source]: principalId.parse(ulid()), [target]: principalId.parse(ulid()), [elsewhere]: principalId.parse(ulid()) } as Record<string, PrincipalId>;
const bob = principalId.parse(ulid());
const SLUGS: Record<string, ScopeId> = { qonto: source, a3docs: target, elsewhere };
let modelReply = '{"label":"Bank statement","description":"A statement.","category":"bank-statement","confidence":0.92}';
const run = vi.fn(async (input: { system: string }) => ({ text: input.system.includes('yes/no') ? '{"answer":"yes"}' : modelReply }));

const deps: AutomationDeps = {
  ownerScope: async (n) => host.getScope(ada[n.scopeId]!, tenant, scopeId.parse(n.scopeId)),
  ownerPrincipal: async (n) => ada[n.scopeId] ?? null,
  principalIn: async (n, sub) => (sub === 'ada' ? ada[n.scopeId] ?? null : sub === 'bob' && n.scopeId === source ? bob : null),
  scopeAs: (n, p) => host.getScope(principalId.parse(p), tenant, scopeId.parse(n.scopeId)),
  bytesAs: async (n, p) => {
    const a = await host.attachments(principalId.parse(p), tenant, scopeId.parse(n.scopeId));
    return { open: (ref) => a.open(ref), upload: (input) => a.upload({ ...input, visibility: 'internal', body: input.body as Uint8Array }) };
  },
  spaceBySlug: async (_t, slug) => SLUGS[slug] ?? null,
  queueLabel: async (n, p, file) => {
    await host.startJobRun(tenant, scopeId.parse(n.scopeId), { moduleId: DRIVE, job: AUTO_LABEL_JOB, instance: file.id,
      payload: { tenantId: n.tenantId, scopeId: n.scopeId, fileId: file.id, principal: p } satisfies AutoLabelPayload });
  },
  start: async (n, job, instance, payload) => { await host.startJobRun(tenant, scopeId.parse(n.scopeId), { moduleId: DRIVE, job, instance, payload }); },
  model: () => ({ host: { run, status: vi.fn() } as unknown as ModelHost, spec: 'cloudflare:@cf/test', attribution: {} as never }),
  now: () => Date.now(),
};

const scopeOf = (s: ScopeId) => host.getScope(ada[s]!, tenant, s);
const node = (s: ScopeId): Node => ({ tenantId: tenant, scopeId: s });

async function folder(s: ScopeId, name: string, parentId = ROOT_FOLDER_ID): Promise<string> {
  return (await (await scopeOf(s)).invoke<{ id: string }>('drive/create-folder', { parentId, name })).id;
}

async function upload(s: ScopeId, folderId: string, name: string, text: string, as = ada[s]!): Promise<{ id: string; versionId: string }> {
  const stub = await host.getScope(as, tenant, s);
  const file = await stub.invoke<{ id: string }>('drive/ensure-file', { folderId, name });
  const attachment = await (await host.attachments(as, tenant, s)).upload({
    entity: { entityType: 'file', entityId: file.id }, filename: name, contentType: 'text/plain', visibility: 'internal', body: new TextEncoder().encode(text),
  });
  const written = await stub.invoke<{ current_version_id: string }>('drive/record-version', { fileId: file.id, location: { source: 'blob', blobRef: attachment.id } });
  return { id: file.id, versionId: written.current_version_id };
}

/** What the worker does after a write and the sweeper on its pass: kick the dispatcher, then drive. */
async function settle(...spaces: ScopeId[]) {
  for (let round = 0; round < 4; round++) {
    for (const s of spaces) {
      await deps.start(node(s), AUTOMATION_JOB, DISPATCH_INSTANCE, node(s) as unknown as Record<string, unknown>);
      await host.runDueJobs(tenant, s);
    }
  }
}

async function saveFlow(s: ScopeId, name: string, definition: Partial<FlowDefinition> & Pick<FlowDefinition, 'trigger' | 'actions'>, sub = 'ada') {
  return (await scopeOf(s)).invoke<StoredFlow>('drive/save-flow', { name, enabled: true, definition: flowDefinition.parse(definition), authorSub: sub });
}

const deliveries = async (s: ScopeId, flowId: string) =>
  (await (await scopeOf(s)).invoke<{ deliveries: FlowDelivery[] }>('drive/flow-deliveries', { flowId })).deliveries;
const filesIn = async (s: ScopeId, folderId: string) =>
  (await (await scopeOf(s)).invoke<{ entries: { id: string; name: string }[] }>('drive/list-folder', { folderId })).entries;

let statements: string, bancos: string, inbox: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'canopy-automation-'));
  host = new SqliteScopeHost({ dir, attachmentExtractors: defaultAttachmentExtractors() });
  host.registerModule(driveModule);
  host.registerJob(DRIVE, AUTOMATION_JOB, automationJob(deps));
  host.registerJob(DRIVE, FLOW_RUN_JOB, flowRunJob(deps));
  host.registerJob(DRIVE, FLOW_BACKFILL_JOB, flowBackfillJob(deps));
  host.registerJob(DRIVE, AUTO_LABEL_JOB, autoLabelJob({
    scopeFor: (p) => host.getScope(principalId.parse(p.principal), tenantId.parse(p.tenantId), scopeId.parse(p.scopeId)),
    enabled: async () => true,
    categories: async () => [{ id: 'bank-statement', name: 'Bank statement' }, { id: 'invoice', name: 'Invoice' }],
    now: () => Date.now(),
    model: () => ({ host: { run, status: vi.fn() } as unknown as ModelHost, spec: 'cloudflare:@cf/test', attribution: {} as never }),
  }));
  await host.admin.createTenant(staff, { id: tenant, slug: 'flows', name: 'Flows' });
  await host.admin.grantEntitlement(staff, tenant, driveManifest.entitlementKey as string);
  await host.provisionBlobStore(staff, { tenantId: tenant, vertical: 'drive', binding: 'BLOBS' });
  for (const role of ROLES) await host.admin.defineRole(staff, tenant, role);
  for (const s of [source, target, elsewhere]) {
    await host.provisionScope(staff, { tenantId: tenant, scopeId: s, vertical: 'drive' });
    await host.admin.activateScope(staff, tenant, s);
    await host.admin.assignRole(staff, { principalId: ada[s]!, roleKey: 'owner', node: { tenantId: tenant, scopeId: s } });
  }
  await host.admin.assignRole(staff, { principalId: bob, roleKey: 'owner', node: { tenantId: tenant, scopeId: source } });
  statements = await folder(source, 'Statements');
  inbox = await folder(source, 'Inbox');
  bancos = await folder(target, 'Bancos');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('flows across spaces', () => {
  it('copies a statement that arrives in a folder into another space, once, and never back', async () => {
    const flow = await saveFlow(source, 'Statements to a3doc', {
      trigger: { on: 'arrived' }, mode: 'auto',
      conditions: [{ field: 'folder', op: 'under', path: 'Statements' }],
      actions: [{ type: 'copy', space: 'a3docs', folderId: bancos, alsoIn: [] }],
    });
    // A flow in the target that would send everything straight back: it must never see the copy.
    const back = await saveFlow(target, 'Echo', { trigger: { on: 'arrived' }, mode: 'auto', actions: [{ type: 'copy', space: 'qonto', folderId: inbox, alsoIn: [] }] });
    const file = await upload(source, statements, 'Statement 2026-10.txt', 'Account statement October 2026');
    await upload(source, inbox, 'Other.txt', 'not a statement');
    await settle(source, target);

    const copied = await filesIn(target, bancos);
    expect(copied.map((f) => f.name)).toEqual(['Statement 2026-10.txt']);
    const details = await (await scopeOf(target)).invoke<{ origin: { flowId: string; sourceFileId: string } }>('drive/file-details', { fileId: copied[0]!.id });
    expect(details.origin).toMatchObject({ flowId: flow.id, sourceFileId: file.id, sourceScope: source });
    const [delivery] = await deliveries(source, flow.id);
    expect(delivery).toMatchObject({ fileId: file.id, versionId: file.versionId, state: 'done', detail: { targets: [{ space: 'a3docs', fileId: copied[0]!.id }] } });
    expect(await deliveries(target, back.id)).toEqual([]);
    expect((await filesIn(source, inbox)).map((f) => f.name)).toEqual(['Other.txt']);

    // Offered again (a later sweep, a backfill): nothing new is made.
    await deps.start(node(source), FLOW_BACKFILL_JOB, flow.id, { ...node(source), flowId: flow.id });
    await settle(source, target);
    expect((await filesIn(target, bancos)).length).toBe(1);
    await (await scopeOf(source)).invoke('drive/delete-flow', { id: flow.id });
    await (await scopeOf(target)).invoke('drive/delete-flow', { id: back.id });
  });

  it('proposes a match in ask mode, and acts once it is approved', async () => {
    const flow = await saveFlow(source, 'Ask first', {
      trigger: { on: 'arrived' }, mode: 'ask',
      conditions: [{ field: 'name', op: 'matches', value: 'Invoice *' }],
      actions: [{ type: 'copy', space: 'a3docs', folderId: bancos, alsoIn: [] }],
    });
    const file = await upload(source, inbox, 'Invoice 7.txt', 'Invoice 7 from ACME');
    await settle(source);
    expect(await deliveries(source, flow.id)).toMatchObject([{ fileId: file.id, state: 'proposed' }]);
    expect((await filesIn(target, bancos)).map((f) => f.name)).not.toContain('Invoice 7.txt');

    await (await scopeOf(source)).invoke('drive/record-flow-delivery', { flowId: flow.id, fileId: file.id, versionId: file.versionId, state: 'approved', expect: ['proposed'] });
    await deps.start(node(source), FLOW_RUN_JOB, `${flow.id}:${file.id}:${file.versionId}`, { ...node(source), flowId: flow.id, fileId: file.id, versionId: file.versionId, approved: true });
    await settle(source, target);
    expect(await deliveries(source, flow.id)).toMatchObject([{ state: 'done' }]);
    expect((await filesIn(target, bancos)).map((f) => f.name)).toContain('Invoice 7.txt');
    await (await scopeOf(source)).invoke('drive/delete-flow', { id: flow.id });
  });

  it('fires on the category Document AI chose, and on a yes to its question', async () => {
    modelReply = '{"label":"Bank statement","description":"A statement.","category":"bank-statement","confidence":0.92}';
    const flow = await saveFlow(source, 'By category', {
      trigger: { on: 'classified' }, mode: 'auto',
      conditions: [{ field: 'category', values: ['bank-statement'], minConfidence: 0.8 }, { field: 'ask', question: 'Is this a monthly statement?' }],
      actions: [{ type: 'label', value: 'Sent to gestoría' }],
    });
    const file = await upload(source, inbox, 'scan-0091.txt', 'BBVA extracto mensual octubre');
    await settle(source);
    const details = await (await scopeOf(source)).invoke<{ labels: string[]; category: { id: string; source: string; confidence: number } }>('drive/file-details', { fileId: file.id });
    expect(details.category).toMatchObject({ id: 'bank-statement', source: 'ai', confidence: 0.92 });
    expect(details.labels).toEqual(expect.arrayContaining(['Bank statement', 'Sent to gestoría']));
    expect(await deliveries(source, flow.id)).toMatchObject([{ fileId: file.id, state: 'done' }]);
    expect(run.mock.calls.some(([input]) => (input as { system: string }).system.includes('yes/no'))).toBe(true);
    await (await scopeOf(source)).invoke('drive/delete-flow', { id: flow.id });
  });

  it('fails a delivery with the reason when its author cannot write there, and keeps nothing half-made', async () => {
    // Bob is in the source space only: his flow cannot copy into a3docs.
    const flow = await saveFlow(source, "Bob's", {
      trigger: { on: 'arrived' }, mode: 'auto',
      conditions: [{ field: 'name', op: 'contains', value: 'bob-only' }],
      actions: [{ type: 'copy', space: 'a3docs', folderId: bancos, alsoIn: [] }],
    }, 'bob');
    await upload(source, inbox, 'bob-only.txt', 'x');
    await settle(source, target);
    const [delivery] = await deliveries(source, flow.id);
    expect(delivery).toMatchObject({ state: 'failed', detail: { error: expect.stringContaining('not a member') } });
    expect((await (await scopeOf(source)).invoke<{ flows: StoredFlow[] }>('drive/list-flows')).flows.find((f) => f.id === flow.id)!.failures).toBe(1);
    await (await scopeOf(source)).invoke('drive/delete-flow', { id: flow.id });
  });

  it('copies into an a3doc space and sends the copy on to a3doc, in the categories asked', async () => {
    const fiscal = await folder(target, 'Fiscal');
    await (await scopeOf(target)).invoke('drive/record-source', { provider: 'canopy.a3doc', connectionId: 'c', account: 'ACME', folder: 'F', canUpload: true });
    const flow = await saveFlow(source, 'To a3doc', {
      trigger: { on: 'arrived' }, mode: 'auto',
      conditions: [{ field: 'name', op: 'contains', value: 'Extracto' }],
      actions: [{ type: 'copy', space: 'a3docs', folderId: bancos, alsoIn: [fiscal] }],
    });
    const file = await upload(source, statements, 'Extracto 11.txt', 'Extracto noviembre');
    await settle(source, target);
    const [delivery] = await deliveries(source, flow.id);
    expect(delivery).toMatchObject({ fileId: file.id, state: 'done', detail: { targets: [{ sent: true }] } });
    const sent = await host.admin.queryScope(staff, tenant, target, { sql: "SELECT payload FROM _substrat_outbox WHERE type = 'a3doc.files-requested' ORDER BY id DESC LIMIT 1" });
    expect(JSON.parse(String(sent.rows[0]![0]))).toMatchObject({ directory: 'Bancos', alsoIn: ['Fiscal'], files: [{ name: 'Extracto 11.txt' }] });
  });

  it('copies each new version into the same file when a flow acts on every version', async () => {
    const archive = await folder(elsewhere, 'Archive');
    const flow = await saveFlow(source, 'Every version', {
      trigger: { on: 'arrived' }, mode: 'auto', versions: 'every',
      conditions: [{ field: 'name', op: 'contains', value: 'Ledger' }],
      actions: [{ type: 'copy', space: 'elsewhere', folderId: archive, alsoIn: [] }],
    });
    const first = await upload(source, statements, 'Ledger.txt', 'one');
    await settle(source, elsewhere);
    const second = await upload(source, statements, 'Ledger.txt', 'two');
    await settle(source, elsewhere);
    const copies = await filesIn(elsewhere, archive);
    expect(copies.map((f) => f.name)).toEqual(['Ledger.txt']);
    const details = await (await scopeOf(elsewhere)).invoke<{ origin: { sourceVersionId: string } }>('drive/file-details', { fileId: copies[0]!.id });
    expect(details.origin.sourceVersionId).toBe(second.versionId);
    const done = (await deliveries(source, flow.id)).filter((d) => d.state === 'done').map((d) => d.versionId).sort();
    expect(done).toEqual([first.versionId, second.versionId].sort());
    await (await scopeOf(source)).invoke('drive/delete-flow', { id: flow.id });
  });

  it('runs a scheduled flow over what arrived since it last ran', async () => {
    const flow = await saveFlow(elsewhere, 'Daily', {
      trigger: { on: 'schedule', every: 'day' }, mode: 'auto', actions: [{ type: 'label', value: 'Seen' }],
    });
    const file = await upload(elsewhere, ROOT_FOLDER_ID, 'note.txt', 'hello');
    await settle(elsewhere);
    expect(await deliveries(elsewhere, flow.id)).toMatchObject([{ fileId: file.id, state: 'done' }]);
    const ran = (await (await scopeOf(elsewhere)).invoke<{ flows: StoredFlow[] }>('drive/list-flows')).flows[0]!;
    expect(ran.lastRunAt).not.toBeNull();
    expect((await (await scopeOf(elsewhere)).invoke<{ dueSchedules: number }>('drive/automation-pending')).dueSchedules).toBe(0);
  });
});

describe('parseAnswer', () => {
  it('reads yes or no, and nothing else', () => {
    expect(parseAnswer('{"answer": "YES"}')).toBe(true);
    expect(parseAnswer('no, it is not')).toBe(false);
    expect(parseAnswer('maybe')).toBeNull();
  });
});
