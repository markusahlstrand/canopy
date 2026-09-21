/**
 * Does each drive handler honour the entity check its operation DECLARED? (#44)
 *
 * Every one of the drive's six operations narrows: `permission: { key, entity,
 * idFrom }`. Nothing verified that the handler behind the declaration actually
 * checks against THAT entity. A handler calling `ctx.check(DRIVE_PERM.read)`
 * beside a declaration of `entity: 'file'` typechecks perfectly and fails open —
 * and in a sharing app, which is the whole of canopy, "fails open" means every
 * member of a space passes against every file in it.
 *
 * The kit generates the behavioural pair that separates the two, from the
 * declaration itself, so a seventh operation is covered the day it is written.
 * What it cannot drive it names, and the list is asserted — losing coverage turns
 * CI red and shows up in the diff rather than going quiet.
 *
 * This is the half of S3 that tests CANOPY. The suites next door in
 * `kernel-contract.test.ts` test the adapter canopy runs on, which is a different
 * claim with a different owner; the header there says so.
 */
import { afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { entityCheckConformanceSuite, type EntityCheckFixture } from '@substrat-run/contract-tests';
import { permissionKey, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { DRIVE_PERM, driveManifest, driveModule, ROOT_FOLDER_ID } from '../src/index.js';
import { driveOperations } from '../spec/model.js';
import { ROLES } from '../src/provision.js';

const staff = platformActorId.parse(ulid());

/** Every case gets its own store; the kit gives the fixture no `cleanup` hook. */
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * A world nobody else has touched, per case — the kit calls this once for each
 * half of each pair, because the operation under test may well delete the thing
 * it is handed.
 */
async function makeFixture(): Promise<EntityCheckFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'canopy-entity-check-'));
  dirs.push(dir);
  const host = new SqliteScopeHost({ dir });
  host.registerModule(driveModule);

  const tenant = tenantId.parse(ulid());
  const scope = scopeId.parse(ulid());
  /** Builds the world each case is handed. Never the probe. */
  const owner = principalId.parse(ulid());
  /**
   * Holds NOTHING scope-wide, and deliberately holds no role either.
   *
   * Canopy's `member` carries `drive:read` across the whole space — membership
   * is the grant, which is the drive's own design. A member probe would pass
   * case 2 on every read operation for a reason that has nothing to do with the
   * narrowing under test, and the pair would report conformance it never showed.
   */
  const probe = principalId.parse(ulid());

  await host.admin.createTenant(staff, {
    id: tenant,
    slug: `conf-${tenant.slice(-6).toLowerCase()}`,
    name: 'Conformance',
  });
  await host.admin.grantEntitlement(staff, tenant, driveManifest.entitlementKey as string);
  await host.provisionScope(staff, { tenantId: tenant, scopeId: scope, vertical: 'drive' });
  await host.provisionBlobStore(staff, { tenantId: tenant, vertical: 'drive', binding: 'BLOBS' });
  await host.admin.activateScope(staff, tenant, scope);
  for (const role of ROLES) await host.admin.defineRole(staff, tenant, role);

  // The owner's bootstrap grant, as `provision.ts` gives it in a real install:
  // write and manage on the ROOT folder, reaching everything beneath through the
  // declared parent edge.
  for (const permission of [DRIVE_PERM.write, DRIVE_PERM.manage]) {
    await host.admin.grant(staff, {
      principalId: owner,
      permission,
      node: { tenantId: tenant, scopeId: scope },
      entity: { entityType: 'folder', entityId: ROOT_FOLDER_ID },
      grantedBy: owner,
    });
  }

  const asOwner = async <T>(operation: string, input: Record<string, unknown>): Promise<T> =>
    (await host.getScope(owner, tenant, scope)).invoke<T>(operation, input);

  return {
    /**
     * Built through the drive's own write operations rather than by reaching into
     * its tables: a row inserted behind the module's back can be shaped in a way
     * the handlers never produce, and then the pair measures the fixture.
     */
    createEntity: async (entityType: string): Promise<string> => {
      const name = `probe-${ulid().slice(-10)}`;
      if (entityType === 'folder') {
        return (await asOwner<{ id: string }>('drive/create-folder', { parentId: ROOT_FOLDER_ID, name })).id;
      }
      if (entityType === 'file') {
        return (await asOwner<{ id: string }>('drive/ensure-file', { folderId: ROOT_FOLDER_ID, name })).id;
      }
      throw new Error(`the drive declares no entity '${entityType}' this fixture knows how to create`);
    },

    /**
     * The ADMIN grant, never `drive/`'s own sharing path — setting a test up with
     * the operation it is testing proves only that it agrees with itself.
     */
    grantOnEntity: async (permission, entity) => {
      await host.admin.grant(staff, {
        principalId: probe,
        permission: permissionKey.parse(permission),
        node: { tenantId: tenant, scopeId: scope },
        entity,
        grantedBy: owner,
      });
    },

    invoke: async (operation, input) => (await host.getScope(probe, tenant, scope)).invoke(operation, input),
  };
}

entityCheckConformanceSuite('@canopy/scope-drive', driveOperations, makeFixture, {
  /**
   * Only what the schema REQUIRES beyond the id the kit supplies. The three reads
   * take nothing else, so they have no entry.
   */
  inputs: {
    'drive/create-folder': { name: 'conformance' },
    'drive/ensure-file': { name: 'conformance' },
    // The `external` branch on purpose: a `blob` version names an attachment the
    // handler verifies, so driving that branch would mean uploading bytes to set
    // up a permission test. `external` needs no store and narrows identically.
    'drive/record-version': {
      location: { source: 'external', externalKey: 'conformance', mime: 'text/plain', size: 1 },
    },
  },
});
