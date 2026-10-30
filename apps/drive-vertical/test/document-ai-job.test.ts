/**
 * Document AI as a real kernel job: registered on a host, started per file, driven by
 * `runDueJobs` — the same calls the worker and the sweeper make. Only the model is fake.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { defaultAttachmentExtractors } from '@substrat-run/attachment-extractors';
import { moduleId, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import type { ModelHost } from '@substrat-run/vertical-host/model';
import { DRIVE_PERM, ROOT_FOLDER_ID, driveManifest, driveModule } from '@canopy/scope-drive';
import { ROLES } from '@canopy/scope-drive/provision';
import { AUTO_LABEL_JOB, autoLabelJob, type AutoLabelPayload } from '../src/document-ai';

let dir: string;
let host: SqliteScopeHost;
const staff = platformActorId.parse(ulid());
const tenant = tenantId.parse(ulid());
const scope = scopeId.parse(ulid());
const ada = principalId.parse(ulid());
const DRIVE = moduleId.parse(driveManifest.id);
const run = vi.fn(async () => ({ text: '{"label":"Invoice","description":"An invoice from ACME Ltd for 120 EUR."}' }));

async function upload(name: string, text: string): Promise<{ id: string }> {
  const stub = await host.getScope(ada, tenant, scope);
  const file = await stub.invoke<{ id: string }>('drive/ensure-file', { folderId: ROOT_FOLDER_ID, name });
  const attachment = await (await host.attachments(ada, tenant, scope)).upload({
    entity: { entityType: 'file', entityId: file.id }, filename: name, contentType: 'text/plain', visibility: 'internal',
    body: new TextEncoder().encode(text),
  });
  await stub.invoke('drive/record-version', { fileId: file.id, location: { source: 'blob', blobRef: attachment.id } });
  return file;
}

const start = (file: { id: string }, name: string) => host.startJobRun(tenant, scope, {
  moduleId: DRIVE, job: AUTO_LABEL_JOB, instance: file.id,
  payload: { tenantId: tenant, scopeId: scope, fileId: file.id, name, principal: ada } satisfies AutoLabelPayload,
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'canopy-document-ai-'));
  host = new SqliteScopeHost({ dir, attachmentExtractors: defaultAttachmentExtractors() });
  host.registerModule(driveModule);
  host.registerJob(DRIVE, AUTO_LABEL_JOB, autoLabelJob({
    scopeFor: (p) => host.getScope(principalId.parse(p.principal), tenantId.parse(p.tenantId), scopeId.parse(p.scopeId)),
    enabled: async () => true,
    model: () => ({ host: { run, status: vi.fn() } as unknown as ModelHost, spec: 'cloudflare:@cf/test', attribution: {} as never }),
  }));
  await host.admin.createTenant(staff, { id: tenant, slug: 'docai', name: 'Document AI' });
  await host.admin.grantEntitlement(staff, tenant, driveManifest.entitlementKey as string);
  await host.provisionScope(staff, { tenantId: tenant, scopeId: scope, vertical: 'drive' });
  await host.provisionBlobStore(staff, { tenantId: tenant, vertical: 'drive', binding: 'BLOBS' });
  await host.admin.activateScope(staff, tenant, scope);
  for (const role of ROLES) await host.admin.defineRole(staff, tenant, role);
  await host.admin.assignRole(staff, { principalId: ada, roleKey: 'member', node: { tenantId: tenant, scopeId: scope } });
  await host.admin.grant(staff, {
    principalId: ada, permission: DRIVE_PERM.write, node: { tenantId: tenant, scopeId: scope },
    entity: { entityType: 'folder', entityId: ROOT_FOLDER_ID }, grantedBy: ada,
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('Document AI on a kernel host', () => {
  it('labels an upload in the same drive that extracts its text, and joins a live run on a second save', async () => {
    const file = await upload('acme-0042.txt', 'ACME Ltd — invoice 0042 — total 120 EUR');
    const queued = await start(file, 'acme-0042.txt');
    // A second save before anything drove it joins the run rather than starting another.
    expect((await start(file, 'acme-0042.txt')).id).toBe(queued.id);

    // One drive, as after an upload: the kernel's extraction, then this run.
    await host.runDueJobs(tenant, scope);
    const details = await (await host.getScope(ada, tenant, scope)).invoke('drive/file-details', { fileId: file.id });
    expect(details).toMatchObject({ labels: ['Invoice'], description: 'An invoice from ACME Ltd for 120 EUR.' });
    expect(await host.jobRuns(tenant, scope, { moduleId: DRIVE, job: AUTO_LABEL_JOB, instance: file.id }))
      .toMatchObject([{ id: queued.id, status: 'done', counters: { labelled: 1 } }]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('finishes without a model call for a file with no text layer', async () => {
    const file = await upload('scan.txt', '   \n  ');
    await start(file, 'scan.txt');
    await host.runDueJobs(tenant, scope);
    expect(await host.jobRuns(tenant, scope, { moduleId: DRIVE, job: AUTO_LABEL_JOB, instance: file.id }))
      .toMatchObject([{ status: 'done', counters: { 'skipped:no-text': 1 } }]);
    expect(run).not.toHaveBeenCalled();

    // A skip before the model saw anything does not close the file: real text later gets a new run.
    await (await host.getScope(ada, tenant, scope)).invoke('drive/record-version', {
      fileId: file.id,
      location: { source: 'blob', blobRef: (await (await host.attachments(ada, tenant, scope)).upload({
        entity: { entityType: 'file', entityId: file.id }, filename: 'scan.txt', contentType: 'text/plain', visibility: 'internal',
        body: new TextEncoder().encode('Lease agreement between A and B'),
      })).id },
    });
    const again = await start(file, 'scan.txt');
    await host.runDueJobs(tenant, scope);
    expect((await host.jobRuns(tenant, scope, { moduleId: DRIVE, job: AUTO_LABEL_JOB, instance: file.id })).find((r) => r.id === again.id))
      .toMatchObject({ status: 'done', counters: { labelled: 1 } });
  });
});
