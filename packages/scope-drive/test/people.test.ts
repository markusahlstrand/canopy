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
interface Person {
  principal: string;
  email: string | null;
  name: string | null;
  seen_at: string;
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

describe('the roster remembers what to call people', () => {
  it('records the caller and reads back, the newest name winning', async () => {
    await (await as(bjorn)).invoke('drive/record-person', {
      email: 'bjorn@example.com',
      name: 'Bjorn',
    });
    // A second sign-in with a changed name: the row is replaced, not duplicated.
    await (await as(bjorn)).invoke('drive/record-person', {
      email: 'bjorn@example.com',
      name: 'Bjorn Egerland',
    });

    const { people } = await (await as(ada)).invoke<{ people: Person[] }>('drive/list-people', {});
    const mine = people.filter((p) => p.principal === bjorn);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.name).toBe('Bjorn Egerland');
  });

  it('lands a claim on the CLAIMANT, never on the person claimed', async () => {
    // Cleo records herself as Ada. The name and address are self-asserted — they are
    // whatever the issuer released, and a display name is self-asserted in every product
    // that has one. WHOSE ROW it lands on is not.
    //
    // Two things hold that: the input schema has no `principal` field, so an extra one is
    // stripped before the handler runs, and the handler writes `ctx.principal`.
    //
    // The forged field is IN the payload below, which it has to be — without it, a schema
    // that gained the field and a handler that then read `input.principal ?? ctx.principal`
    // would leave this test green, because there would be nothing to prefer. With it, either
    // half regressing fails here.
    await (await as(cleo)).invoke('drive/record-person', {
      email: 'ada@example.com',
      name: 'Ada',
      principal: ada,
    });

    const { people } = await (await as(ada)).invoke<{ people: Person[] }>('drive/list-people', {});
    // Ada has never recorded herself, and nobody else can do it for her.
    expect(people.some((p) => p.principal === ada)).toBe(false);
    expect(people.find((p) => p.principal === cleo)?.email).toBe('ada@example.com');
  });

  it('records a person an issuer says nothing about', async () => {
    // Both claims null. The worker used to skip the call entirely in this case, which made
    // the roster's principal-only row — the one the dialog renders as an id — unreachable
    // in practice while still being rendered and tested. It writes nulls now, so this is
    // the shape that actually arrives.
    await (await as(bjorn)).invoke('drive/record-person', { email: null, name: null });

    const { people } = await (await as(ada)).invoke<{ people: Person[] }>('drive/list-people', {});
    const row = people.find((p) => p.principal === bjorn);
    expect(row).toBeTruthy();
    expect(row!.email).toBeNull();
    expect(row!.name).toBeNull();
    // And a nameless row sorts last, because a row that can only show a ULID is the least
    // useful thing in a picker.
    expect(people[people.length - 1]!.principal).toBe(bjorn);
  });

  it('is not the roster of record: a member who never signed in is absent', async () => {
    const { people } = await (await as(ada)).invoke<{ people: Person[] }>('drive/list-people', {});
    // Ada is the owner. She is a member because the kernel says so, not because a row here
    // says so — which is why the UI may not present this list as everyone in the space.
    expect(people.some((p) => p.principal === ada)).toBe(false);
  });

  it('refuses a stranger, who is not in the space to be seen in it', async () => {
    await expect(
      (await as(stranger)).invoke('drive/record-person', { email: 'x@example.com', name: 'X' }),
    ).rejects.toThrow();
    await expect((await as(stranger)).invoke('drive/list-people', {})).rejects.toThrow();
  });
});

describe('portal-compatible scope roles', () => {
  it('lets an owner confer editor access but prevents an editor escalating to owner', async () => {
    const editor = principalId.parse(ulid()), viewer = principalId.parse(ulid());
    expect((await host.canAssign(tenant, scope, ada, 'editor')).covered).toBe(true);
    await host.assignScopeRoleBounded(tenant, scope, ada, editor, 'editor');
    await host.assignScopeRoleBounded(tenant, scope, ada, viewer, 'viewer');
    const editable = await host.getScope(editor, tenant, scope);
    const readable = await host.getScope(viewer, tenant, scope);
    expect((await editable.invoke<Access>('drive/people-access')).canManage).toBe(false);
    await editable.invoke('drive/create-folder', {parentId:ROOT_FOLDER_ID,name:'Editor-created folder'});
    await expect(readable.invoke('drive/create-folder', {parentId:ROOT_FOLDER_ID,name:'Viewer cannot create'})).rejects.toThrow();
    expect((await host.canAssign(tenant, scope, editor, 'owner')).covered).toBe(false);
    expect((await host.assignScopeRoleBounded(tenant, scope, editor, viewer, 'owner')).covered).toBe(false);
    expect((await readable.invoke<Access>('drive/people-access')).canManage).toBe(false);
  });
});

describe('creating shared spaces through platform intents', () => {
  it('queues one durable request for repeated creation submissions and reads only the creator outcomes', async () => {
    const owner = ulid(); const stub = await as(ada);
    const first = await stub.invoke<{id: string}>('drive/request-space', { name: 'Family', slug: 'family', owner });
    const again = await stub.invoke<{id: string}>('drive/request-space', { name: 'Family', slug: 'family', owner });
    expect(again.id).toBe(first.id);
    const requests = await stub.invoke<{requests: {id: string; status: string}[]}>('drive/space-requests', {});
    expect(requests.requests).toHaveLength(1); expect(requests.requests[0]).toMatchObject({ id: first.id, status: 'pending' });
  });
  it('refuses space creation and provisioning outcomes to members and folder-only managers', async () => {
    for (const who of [bjorn, cleo]) {
      const stub = await as(who);
      await expect(stub.invoke('drive/request-space', { name: 'No', slug: 'no', owner: ulid() })).rejects.toThrow();
      await expect(stub.invoke('drive/space-requests', {})).rejects.toThrow();
    }
  });
});

describe('persistent plugin installations', () => {
  const manifest = { id: 'notes-viewer', name: 'Notes', version: '1', capabilities: [{kind: 'item:read'}], contributes: {viewers: [{id: 'notes', match: ['.notes']}]}};
  it('isolates personal installs and rejects stale replacements', async () => {
    const owner = await as(ada), member = await as(bjorn);
    const first = await owner.invoke<{id: string; updated_at: string}>('drive/save-plugin', {manifest, source: 'export default function() {}', expectedRevision: null});
    expect((await member.invoke<{plugins: unknown[]}>('drive/list-plugins', {})).plugins).toEqual([]);
    await expect(member.invoke('drive/toggle-plugin', {id: first.id, enabled: false})).rejects.toThrow();
    await expect(owner.invoke('drive/save-plugin', {manifest, source: 'changed', expectedRevision: null})).rejects.toThrow('changed');
    const updated = await owner.invoke<{updated_at: string}>('drive/save-plugin', {manifest, source: 'changed', expectedRevision: first.updated_at});
    expect(updated.updated_at).not.toBe(first.updated_at);
    await owner.invoke('drive/remove-plugin', {id: first.id});
    expect((await owner.invoke<{plugins: unknown[]}>('drive/list-plugins', {})).plugins).toEqual([]);
  });
  it('lets owners apply a plugin to the space and members use but not change it', async () => {
    const owner = await as(ada), member = await as(bjorn);
    await expect(member.invoke('drive/save-plugin', {manifest, source: 'code', forSpace: true, expectedRevision: null})).rejects.toThrow();
    const install = await owner.invoke<{id: string}>('drive/save-plugin', {manifest, source: 'code', forSpace: true, expectedRevision: null});
    expect((await member.invoke<{plugins: {id: string}[]}>('drive/list-plugins', {})).plugins[0]?.id).toBe(install.id);
    await expect(member.invoke('drive/remove-plugin', {id: install.id})).rejects.toThrow();
    const disabled = await owner.invoke<{enabled: number}>('drive/toggle-plugin', {id: install.id, enabled: false}); expect(disabled.enabled).toBe(0);
  });
  it('rejects unsupported capabilities and unsafe network host patterns', async () => {
    const stub = await as(ada);
    for (const capabilities of [[{kind: 'storage:read'}], [{kind: 'net:fetch', hosts: ['https://evil.test/; script-src *']} ]]) {
      await expect(stub.invoke('drive/save-plugin', {manifest: {...manifest, capabilities}, source: 'code', expectedRevision: null})).rejects.toThrow();
    }
  });
});

describe('plugin review boundaries',()=>{
 const manifest={id:'review-viewer',name:'Review',version:'1',capabilities:[{kind:'item:read'}],contributes:{viewers:[{id:'review',match:['.review']}]}};
 it('preserves disabled installs, requires exact consent for widened access, and returns metadata without source',async()=>{
  const owner=await as(ada);const first=await owner.invoke<{id:string;updated_at:string;source_sha256:string}>('drive/save-plugin',{manifest,source:'code',forSpace:true,expectedRevision:null});expect(first.source_sha256).toMatch(/^[a-f0-9]{64}$/);
  const disabled=await owner.invoke<{updated_at:string}>('drive/toggle-plugin',{id:first.id,enabled:false});const caps=[{kind:'item:read'},{kind:'net:fetch',hosts:['collector.example']}];
  await expect(owner.invoke('drive/save-plugin',{manifest:{...manifest,capabilities:caps},source:'new',forSpace:true,expectedRevision:disabled.updated_at})).rejects.toThrow('Approve');
  const updated=await owner.invoke<{enabled:number;updated_at:string}>('drive/save-plugin',{manifest:{...manifest,capabilities:caps},source:'new',forSpace:true,expectedRevision:disabled.updated_at,acceptCapabilities:caps});expect(updated.enabled).toBe(0);
  const listed=await owner.invoke<{plugins:Record<string,unknown>[]}>('drive/list-plugins',{});expect(listed.plugins.find(row=>row.id===first.id)).not.toHaveProperty('source');
  await expect(owner.invoke('drive/plugin-source',{id:first.id,revision:disabled.updated_at})).rejects.toThrow('changed');expect((await owner.invoke<{source:string}>('drive/plugin-source',{id:first.id,revision:updated.updated_at})).source).toBe('new');
 });
 it('refuses folder-only managers, foreign personal removals, and private network hosts',async()=>{
  const owner=await as(ada),member=await as(bjorn),narrowed=await as(cleo);
  const row=await owner.invoke<{id:string}>('drive/save-plugin',{manifest:{...manifest,id:'private-viewer'},source:'code',expectedRevision:null});await expect(member.invoke('drive/remove-plugin',{id:row.id})).rejects.toThrow();
  await expect(narrowed.invoke('drive/save-plugin',{manifest,source:'code',forSpace:true,expectedRevision:null})).rejects.toThrow();
  for(const host of ['localhost','127.0.0.1','192.168.1.1','169.254.169.254','nas.local','svc.internal'])await expect(owner.invoke('drive/save-plugin',{manifest:{...manifest,capabilities:[{kind:'net:fetch',hosts:[host]}]},source:'code',expectedRevision:null})).rejects.toThrow();
 });
});

it('bounds aggregate plugin bytes and removes personal installs with their member',async()=>{
 const who=principalId.parse(ulid());await host.admin.assignRole(staff,{principalId:who,roleKey:'member',node:{tenantId:tenant,scopeId:scope}});const member=await host.getScope(who,tenant,scope),owner=await as(ada);
 const manifest={id:'quota-viewer',name:'Quota',version:'1',capabilities:[{kind:'item:read'}],contributes:{viewers:[{id:'quota',match:['.quota']}]}};
 await expect(member.invoke('drive/save-plugin',{manifest,source:'é'.repeat(128001),expectedRevision:null})).rejects.toThrow('256 KB');
 let refused=false;for(let i=0;i<22;i++){try{await member.invoke('drive/save-plugin',{manifest:{...manifest,id:'quota-viewer-'+i},source:'x'.repeat(250000),expectedRevision:null});}catch(error){expect(String(error)).toContain('5 MB');refused=true;break;}}expect(refused).toBe(true);
 await owner.invoke('drive/forget-person',{principal:who});expect((await member.invoke<{plugins:unknown[]}>('drive/list-plugins',{})).plugins.filter((row:unknown)=>(row as {principal:string}).principal===who)).toEqual([]);
});
