/**
 * Sharing a folder (#79) — measured by what people can DO, not by what was recorded.
 *
 * The projection is the easy half and the uninteresting one: a row saying somebody has
 * access proves nothing, because the row grants nothing. So every claim here is made by
 * having the shared-with person attempt a write and watching it be refused or allowed.
 *
 * Four properties, in the order they matter:
 *
 *  1. a share changes access, and withdrawing it changes access back
 *  2. it reaches DOWN — everything under the folder, through the declared parent edge —
 *     and no further sideways than the folder itself
 *  3. sharing is an owner's act on that folder: write does not confer it
 *  4. what is handed on cannot exceed what the giver holds (the kernel's bound, which this
 *     drive relies on rather than re-implements)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { ROOT_FOLDER_ID, driveManifest, driveModule } from '../src/index.js';
import { ROLES } from '../src/provision.js';

let dir: string;
let host: ScopeHost;

const staff = platformActorId.parse(ulid());
const tenant = tenantId.parse(ulid());
const scope = scopeId.parse(ulid());
/** The owner: holds everything at the node, so she is the one who can share. */
const ada = principalId.parse(ulid());
/** A member: reads the whole space, writes nowhere until a folder is shared with her. */
const bjorn = principalId.parse(ulid());
/** Another member, so a share can be passed on to somebody. */
const cleo = principalId.parse(ulid());

interface FolderRow {
  id: string;
  path: string;
}
interface Share {
  folder_id: string;
  principal: string;
  permission: string;
  granted_by: string;
  email: string | null;
  name: string | null;
}

const as = (who: typeof ada) => host.getScope(who, tenant, scope);

/** Papers, and a folder inside it — the subtree a share has to reach. */
let papers: string;
let inside: string;
/** A folder nobody shares, to show a share does not spread sideways. */
let private_: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'canopy-drive-sharing-'));
  host = new SqliteScopeHost({ dir });
  host.registerModule(driveModule);

  await host.admin.createTenant(staff, { id: tenant, slug: 'sharing', name: 'Sharing' });
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

  const owner = await as(ada);
  papers = (await owner.invoke<FolderRow>('drive/create-folder', { parentId: ROOT_FOLDER_ID, name: 'Papers' })).id;
  inside = (await owner.invoke<FolderRow>('drive/create-folder', { parentId: papers, name: 'Leases' })).id;
  private_ = (await owner.invoke<FolderRow>('drive/create-folder', { parentId: ROOT_FOLDER_ID, name: 'Private' })).id;

  // So the share list has a name to show rather than a ULID.
  await (await as(bjorn)).invoke('drive/record-person', { email: 'bjorn@example.com', name: 'Bjorn' });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Can this person write in that folder? Asked by trying, which is the only honest way. */
async function canWriteIn(who: typeof ada, folderId: string, name: string): Promise<boolean> {
  try {
    await (await as(who)).invoke('drive/create-folder', { parentId: folderId, name });
    return true;
  } catch {
    return false;
  }
}

describe('a share changes what somebody can do', () => {
  it('turns a refusal into a write, and back again', async () => {
    // A member reads the space and writes nowhere. This is the baseline the share moves.
    expect(await canWriteIn(bjorn, papers, 'before')).toBe(false);

    await (await as(ada)).invoke('drive/share-folder', {
      folderId: papers,
      principal: bjorn,
      permission: 'drive:write',
    });
    expect(await canWriteIn(bjorn, papers, 'after')).toBe(true);

    await (await as(ada)).invoke('drive/unshare-folder', {
      folderId: papers,
      principal: bjorn,
      permission: 'drive:write',
    });
    // Withdrawn means withdrawn — the row is gone and so is the access.
    expect(await canWriteIn(bjorn, papers, 'after-withdrawal')).toBe(false);
  });

  it('reaches everything under the folder, and nothing beside it', async () => {
    await (await as(ada)).invoke('drive/share-folder', {
      folderId: papers,
      principal: bjorn,
      permission: 'drive:write',
    });

    // DOWN: the kernel walks the declared parent edge, so one grant covers the subtree.
    // This is the whole reason sharing is per folder rather than per file.
    expect(await canWriteIn(bjorn, inside, 'deeper')).toBe(true);
    // Not SIDEWAYS: another folder at the same level is untouched, and neither is the root.
    expect(await canWriteIn(bjorn, private_, 'elsewhere')).toBe(false);
    expect(await canWriteIn(bjorn, ROOT_FOLDER_ID, 'at-the-root')).toBe(false);
  });

  it('lists who has access, with a name rather than a ULID', async () => {
    const { shares } = await (await as(ada)).invoke<{ shares: Share[] }>('drive/list-folder-shares', {
      folderId: papers,
    });
    const his = shares.find((s) => s.principal === bjorn);
    expect(his?.permission).toBe('drive:write');
    expect(his?.email).toBe('bjorn@example.com');
    expect(his?.name).toBe('Bjorn');
    // Who did it, because that is the first question asked about unexpected access.
    expect(his?.granted_by).toBe(ada);
  });

  it('withdrawing something that was never shared is not an error', async () => {
    // The caller wants a state, and that state is already true. Refusing would make a
    // "remove" button in a dialog fail for doing nothing.
    await expect(
      (await as(ada)).invoke('drive/unshare-folder', {
        folderId: private_,
        principal: cleo,
        permission: 'drive:write',
      }),
    ).resolves.toBeTruthy();
  });
});

describe('who may share, and how much', () => {
  it('refuses somebody who can write but does not manage', async () => {
    // Bjorn holds `drive:write` on Papers from the test above. Being able to work in a
    // folder is not being able to give it away.
    await expect(
      (await as(bjorn)).invoke('drive/share-folder', {
        folderId: papers,
        principal: cleo,
        permission: 'drive:write',
      }),
    ).rejects.toThrow();
    expect(await canWriteIn(cleo, papers, 'not-shared-by-bjorn')).toBe(false);
  });

  it('cannot hand out more than the sharer holds', async () => {
    // Ada gives Bjorn `manage` on Papers, so he may share it on.
    await (await as(ada)).invoke('drive/share-folder', {
      folderId: papers,
      principal: bjorn,
      permission: 'drive:manage',
    });

    // On Papers he may, because there he holds it…
    await (await as(bjorn)).invoke('drive/share-folder', {
      folderId: papers,
      principal: cleo,
      permission: 'drive:manage',
    });
    // …and on a folder he holds nothing on, he may not. `ctx.grant` re-checks the caller's
    // own decision on the entity, so this refusal is the kernel's and not the drive's.
    await expect(
      (await as(bjorn)).invoke('drive/share-folder', {
        folderId: private_,
        principal: cleo,
        permission: 'drive:manage',
      }),
    ).rejects.toThrow();
  });

  it('treats the three keys as independent: manage is not a superset of write', async () => {
    // Cleo holds `drive:manage` on Papers from the test above, and that is ALL she holds.
    // The ladder canopy came from was nested — viewer ⊂ editor ⊂ owner — and these keys are
    // not: `manage` is the authority to share a folder and delete what is in it, which does
    // not include putting anything in it.
    expect(await canWriteIn(cleo, papers, 'manage-is-not-write')).toBe(false);

    // She may share, though, which is what manage IS.
    await expect(
      (await as(cleo)).invoke('drive/list-folder-shares', { folderId: papers }),
    ).resolves.toBeTruthy();

    // So "can edit and share" is two grants, and a UI offering it has to make both. This is
    // the fact that decides what the share dialog's levels can be.
    await (await as(ada)).invoke('drive/share-folder', {
      folderId: papers,
      principal: cleo,
      permission: 'drive:write',
    });
    expect(await canWriteIn(cleo, papers, 'now-with-write')).toBe(true);
  });
});

describe('removing a person takes their access with them', () => {
  it('discovers only the caller’s directly shared folders and deduplicates their grants', async () => {
    const owner = await as(ada);
    const folder = await owner.invoke<FolderRow>('drive/create-folder', { parentId: ROOT_FOLDER_ID, name: 'Discovery' });
    for (const permission of ['drive:write', 'drive:manage']) {
      await owner.invoke('drive/share-folder', { folderId: folder.id, principal: bjorn, permission });
    }
    const mine = () => (as(bjorn).then((stub) => stub.invoke<{ folders: FolderRow[] }>('drive/list-shared-folders', {})));
    expect((await mine()).folders.filter((f) => f.id === folder.id)).toHaveLength(1);
    expect((await owner.invoke<{ folders: FolderRow[] }>('drive/list-shared-folders', {})).folders)
      .not.toContainEqual(expect.objectContaining({ id: folder.id }));
    await owner.invoke('drive/rename-folder', { folderId: folder.id, name: 'RenamedDiscovery' });
    expect((await mine()).folders).toContainEqual(expect.objectContaining({ id: folder.id, path: 'RenamedDiscovery' }));
    for (const permission of ['drive:write', 'drive:manage']) {
      await owner.invoke('drive/unshare-folder', { folderId: folder.id, principal: bjorn, permission });
    }
    expect((await mine()).folders).not.toContainEqual(expect.objectContaining({ id: folder.id }));
  });

  it('revokes every folder grant they held, measured by what they can still do', async () => {
    // Cleo ends the tests above holding write and manage on Papers, and can write there.
    expect(await canWriteIn(cleo, papers, 'before-removal')).toBe(true);
    // And she is on the roster, so the removal has a row there to take away too.
    await (await as(cleo)).invoke('drive/record-person', { email: 'cleo@example.com', name: 'Cleo' });

    const gone = await (await as(ada)).invoke<{ revoked: number; forgotten: boolean }>(
      'drive/forget-person',
      { principal: cleo },
    );
    // Both keys, taken back.
    expect(gone.revoked).toBeGreaterThanOrEqual(2);
    expect(gone.forgotten).toBe(true);

    // The claim that matters: not that rows were deleted, but that the access is gone.
    expect(await canWriteIn(cleo, papers, 'after-removal')).toBe(false);
    // And her shares are off the folder's list, so nothing still names her.
    const { shares } = await (await as(ada)).invoke<{ shares: Share[] }>('drive/list-folder-shares', {
      folderId: papers,
    });
    expect(shares.some((s) => s.principal === cleo)).toBe(false);
    // Nor does the roster, which is what every picker is built from.
    const { people } = await (await as(ada)).invoke<{ people: { principal: string }[] }>(
      'drive/list-people',
      {},
    );
    expect(people.some((p) => p.principal === cleo)).toBe(false);
  });

  it('is idempotent, because a removal that failed halfway has to be retryable', async () => {
    const again = await (await as(ada)).invoke<{ revoked: number; forgotten: boolean }>(
      'drive/forget-person',
      { principal: cleo },
    );
    expect(again.revoked).toBe(0);
    expect(again.forgotten).toBe(false);
  });

  it('is not something a member can do, nor somebody a folder was shared with', async () => {
    // Bjorn holds `drive:manage` on Papers from the tests above. Administering who is in the
    // space is node-level, and a grant on one folder does not reach it — otherwise sharing a
    // folder would be a way to remove people from everything.
    await expect(
      (await as(bjorn)).invoke('drive/forget-person', { principal: ada }),
    ).rejects.toThrow();
  });
});
