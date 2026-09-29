/**
 * Who may administer the people in a space (#79).
 *
 * `drive/people-access` exists because an app-side `ScopeStub` can only `invoke`: the
 * platform's invite routes take an admin gate from the vertical, and an operation is the
 * only place the vertical can ask the kernel a permission question. So the thing worth
 * testing is not that it returns a boolean — it is WHICH boolean, for the three shapes of
 * person a drive actually has:
 *
 *  1. the owner, who holds `drive:manage` across the space
 *  2. a member, who holds `drive:read` and nothing else
 *  3. someone a folder was SHARED with — `drive:manage` narrowed to that folder
 *
 * The third is the one that matters. Sharing a folder must not make you an administrator
 * of the space: if a narrowed grant satisfied the unnarrowed check, then handing someone
 * one folder would hand them the ability to invite people into everything. The kernel's
 * narrowing rule is what prevents it, and this is the test that says canopy depends on it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { DRIVE_PERM, ROOT_FOLDER_ID, driveManifest, driveModule } from '../src/index.js';
import { ROLES } from '../src/provision.js';

let dir: string;
let host: ScopeHost;

const staff = platformActorId.parse(ulid());
const tenant = tenantId.parse(ulid());
const scope = scopeId.parse(ulid());
/** The owner: `drive:manage` at the node, which is what administering a space means. */
const ada = principalId.parse(ulid());
/** A member: reads the space, administers nothing. */
const bjorn = principalId.parse(ulid());
/** Shared with: granted on ONE folder, member everywhere else. */
const cleo = principalId.parse(ulid());
/** Nobody at all — no role, no grant. */
const stranger = principalId.parse(ulid());

interface Access {
  canManage: boolean;
}
interface FolderRow {
  id: string;
}

/** The folder Cleo was shared. Set in `beforeAll`, asserted against below. */
let shared: string;

const as = (who: typeof ada) => host.getScope(who, tenant, scope);
const access = async (who: typeof ada): Promise<boolean> =>
  (await (await as(who)).invoke<Access>('drive/people-access')).canManage;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'canopy-drive-people-'));
  host = new SqliteScopeHost({ dir });
  host.registerModule(driveModule);

  await host.admin.createTenant(staff, { id: tenant, slug: 'people', name: 'People' });
  await host.admin.grantEntitlement(staff, tenant, driveManifest.entitlementKey as string);
  await host.provisionScope(staff, { tenantId: tenant, scopeId: scope, vertical: 'drive' });
  await host.admin.activateScope(staff, tenant, scope);
  for (const role of ROLES) await host.admin.defineRole(staff, tenant, role);

  await host.admin.assignRole(staff, {
    principalId: ada,
    roleKey: 'owner',
    node: { tenantId: tenant, scopeId: scope },
  });
  for (const p of [bjorn, cleo]) {
    await host.admin.assignRole(staff, {
      principalId: p,
      roleKey: 'member',
      node: { tenantId: tenant, scopeId: scope },
    });
  }

  // The share itself, made the ADMIN way rather than through the drive's own path — this
  // test must not depend on the operation that will eventually mint it. Both keys, because
  // that is what sharing a folder means here: write to work in it, manage to share it on.
  shared = (
    await (await as(ada)).invoke<FolderRow>('drive/create-folder', {
      parentId: ROOT_FOLDER_ID,
      name: 'Shared with Cleo',
    })
  ).id;
  for (const permission of [DRIVE_PERM.write, DRIVE_PERM.manage]) {
    await host.admin.grant(staff, {
      principalId: cleo,
      permission,
      node: { tenantId: tenant, scopeId: scope },
      entity: { entityType: 'folder', entityId: shared },
      grantedBy: ada,
    });
  }
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('who may manage the people in a space', () => {
  it('says yes to the owner', async () => {
    expect(await access(ada)).toBe(true);
  });

  it('says no to a member, rather than refusing to answer', async () => {
    // A refusal would be the wrong shape: the People surface asks this to decide what to
    // render, and a screen that has to provoke an error to learn what it may show has to
    // read every error as that answer — including the ones that mean something else.
    expect(await access(bjorn)).toBe(false);
  });

  it('says no to someone a folder was shared with', async () => {
    // FIRST, that the share is real. Without this the case below would pass just as well
    // against a grant that never landed — proving nothing about narrowing, which is the
    // only thing it is here to prove.
    const inside = await (await as(cleo)).invoke<FolderRow>('drive/create-folder', {
      parentId: shared,
      name: 'Cleo works here',
    });
    expect(inside.id).toBeTruthy();
    // And she may not do the same at the root, so what she holds is narrowed rather than
    // scope-wide.
    await expect(
      (await as(cleo)).invoke('drive/create-folder', { parentId: ROOT_FOLDER_ID, name: 'nope' }),
    ).rejects.toThrow();

    // The laundering case. Cleo holds `drive:manage` — on one folder. If that satisfied
    // the node-level check, sharing a folder would be a way to hand out the power to
    // invite people into the whole space.
    expect(await access(cleo)).toBe(false);
  });

  it('refuses someone with no place in the space at all', async () => {
    // Not `false`: the gate on ASKING is `drive:read`, and a stranger does not hold it.
    // "You may not manage people here" and "you are not in this space" are different
    // answers and the second one is not this operation's to soften.
    await expect(access(stranger)).rejects.toThrow();
  });
});
