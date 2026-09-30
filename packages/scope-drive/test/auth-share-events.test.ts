/** Share and roster mutations leave permission-stamped facts in the scope event spine. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { ROOT_FOLDER_ID, driveManifest, driveModule } from '../src/index.js';
import { ROLES } from '../src/provision.js';

const staff = platformActorId.parse(ulid());
const tenant = tenantId.parse(ulid());
const scope = scopeId.parse(ulid());
const owner = principalId.parse(ulid());
const member = principalId.parse(ulid());
let dir: string;
let host: SqliteScopeHost;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'canopy-drive-auth-events-'));
  host = new SqliteScopeHost({ dir });
  host.registerModule(driveModule);
  await host.admin.createTenant(staff, { id: tenant, slug: 'auth-events', name: 'Auth events' });
  await host.admin.grantEntitlement(staff, tenant, driveManifest.entitlementKey as string);
  await host.provisionScope(staff, { tenantId: tenant, scopeId: scope, vertical: 'drive' });
  await host.admin.activateScope(staff, tenant, scope);
  for (const role of ROLES) await host.admin.defineRole(staff, tenant, role);
  for (const [principal, roleKey] of [[owner, 'owner'], [member, 'member']] as const) {
    await host.admin.assignRole(staff, {
      principalId: principal, roleKey, node: { tenantId: tenant, scopeId: scope },
    });
  }
});

afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The envelope fields the kernel stamps, not fields the drive can forge in ctx.emit. */
type EventRow = {
  type: string;
  entity_type: string;
  entity_id: string;
  pii_class: string;
  subject_id: string;
  payload: string;
  authorization: string;
  operation: string;
};

async function mutationEvents(): Promise<EventRow[]> {
  const result = await host.admin.queryScope(staff, tenant, scope, {
    sql: `SELECT type, entity_type, entity_id, pii_class, subject_id, payload,
                 authorization, operation FROM _substrat_outbox
          WHERE type IN ('drive.person-recorded', 'drive.folder-shared',
                         'drive.folder-unshared', 'drive.person-forgotten') ORDER BY id`,
  });
  return result.rows.map((row) => Object.fromEntries(result.columns.map((col, i) => [col, row[i]])) as EventRow);
}

describe('drive auth and share events', () => {
  it('records actual mutations with their authorization and without display PII', async () => {
    const memberScope = await host.getScope(member, tenant, scope);
    const ownerScope = await host.getScope(owner, tenant, scope);
    const folder = await ownerScope.invoke<{ id: string }>('drive/create-folder', {
      parentId: ROOT_FOLDER_ID, name: 'Shared',
    });

    await memberScope.invoke('drive/record-person', { email: 'member@example.test', name: 'Member' });
    await memberScope.invoke('drive/record-person', { email: 'member@example.test', name: 'Member' });
    await ownerScope.invoke('drive/share-folder', {
      folderId: folder.id, principal: member, permission: 'drive:write',
    });
    await ownerScope.invoke('drive/unshare-folder', {
      folderId: folder.id, principal: member, permission: 'drive:write',
    });
    await ownerScope.invoke('drive/unshare-folder', {
      folderId: folder.id, principal: member, permission: 'drive:write',
    });
    await ownerScope.invoke('drive/forget-person', { principal: member });

    const events = await mutationEvents();
    expect(events.map((event) => event.type)).toEqual([
      'drive.person-recorded', 'drive.folder-shared',
      'drive.folder-unshared', 'drive.person-forgotten',
    ]);
    expect(events.map((event) => event.operation)).toEqual([
      'drive/record-person', 'drive/share-folder',
      'drive/unshare-folder', 'drive/forget-person',
    ]);
    expect(events.map((event) => event.subject_id)).toEqual([member, member, member, member]);
    expect(events.every((event) => event.pii_class === 'pseudonymous')).toBe(true);
    expect(events.map((event) => event.entity_id)).toEqual([member, folder.id, folder.id, member]);
    expect(events.map((event) => JSON.parse(event.authorization) as unknown[]).every((checks) => checks.length > 0)).toBe(true);
    expect(JSON.stringify(events)).not.toContain('member@example.test');
    expect(events.map((event) => JSON.parse(event.payload) as object)).toEqual([
      { principal: member },
      { principal: member, permission: 'drive:write' },
      { principal: member, permission: 'drive:write' },
      { principal: member, revoked: 0 },
    ]);
  });
});
