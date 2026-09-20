/**
 * The drive, converted: what a space looks like once it is a scope.
 *
 * Every assertion here is about the move rather than about the drive. The drive
 * already works — `@canopy/store` has had these operations for a year. What is
 * being proved is that they still work when the space id is gone, the database is
 * per-scope, and permission is the kernel's rather than `authz.ts`'s.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { principalId, platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { driveModule, driveManifest, DRIVE_PERM, ROOT_FOLDER_ID, driveMigrations } from '../src/index.js';
import { ROLES } from '../src/provision.js';

/**
 * Everyone below is assigned `member` from the SHIPPED role table above, which holds
 * `drive:read` and nothing else: canopy's space membership already means "you see this
 * space's drive" — a family space is shared by being a space, not by granting every
 * folder in it.
 *
 * Write comes from a grant on a folder entity, reaching everything beneath it through
 * the declared parent edge — what `folder_grants` + the `pathRole` walk did by hand,
 * one ancestor at a time. The `owner` role beside `member` is the PROVISIONING path,
 * exercised by a deploy; these tests are about the SHARING path, where a permission has
 * to travel down an edge to mean anything.
 */

let dir: string;
let host: ScopeHost;

const staff = platformActorId.parse(ulid());
const tenant = tenantId.parse(ulid());
const scope = scopeId.parse(ulid());
const otherTenant = tenantId.parse(ulid());
const otherScope = scopeId.parse(ulid());
const ada = principalId.parse(ulid());
const bjorn = principalId.parse(ulid());
const cleo = principalId.parse(ulid());

interface FileRow {
  id: string;
  folder_id: string;
  name: string;
  current_version_id: string | null;
}
interface FolderRow {
  id: string;
  path: string;
}
interface VersionRow {
  id: string;
  source: string;
  blob_ref: string | null;
  mime: string;
  size: number;
}

/**
 * One write, as the drive actually performs one: ensure the file row exists, put the
 * bytes against it through the attachment surface, then record the version that names
 * them. Three hops rather than one because bytes must not ride `invoke` — and an
 * attachment binds to an entity, so the entity has to exist before the bytes can.
 */
async function write(who: typeof ada, folderId: string, name: string, text: string): Promise<FileRow> {
  const stub = await host.getScope(who, tenant, scope);
  const file = await stub.invoke<FileRow>('drive/ensure-file', { folderId, name });
  const body = new TextEncoder().encode(text);
  const attachment = await (await host.attachments(who, tenant, scope)).upload({
    entity: { entityType: 'file', entityId: file.id },
    filename: name,
    contentType: 'text/markdown',
    visibility: 'internal',
    body,
  });
  return stub.invoke<FileRow>('drive/record-version', {
    fileId: file.id,
    location: { source: 'blob', blobRef: attachment.id },
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scope-drive-'));
  host = new SqliteScopeHost({ dir });
  host.registerModule(driveModule);

  for (const [t, s, people] of [
    [tenant, scope, [ada, bjorn]],
    [otherTenant, otherScope, [cleo]],
  ] as const) {
    await host.admin.createTenant(staff, {
      id: t,
      slug: `drive-${t.slice(-6).toLowerCase()}`,
      name: 'Drive',
    });
    await host.admin.grantEntitlement(staff, t, driveManifest.entitlementKey as string);
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'drive' });
    // The byte side of the attachment surface: one store per tenant, minted by the
    // platform and handed over — the vertical never names a bucket. Declared in
    // apps/drive-vertical's runtimeNeeds.blobStores as BLOBS; here the harness plays
    // the part the control plane plays in a deployment.
    await host.provisionBlobStore(staff, { tenantId: t, vertical: 'drive', binding: 'BLOBS' });
    await host.admin.activateScope(staff, t, s);
    for (const role of ROLES) await host.admin.defineRole(staff, t, role);
    for (const p of people) {
      await host.admin.assignRole(staff, {
        principalId: p,
        roleKey: 'member',
        node: { tenantId: t, scopeId: s },
      });
    }
  }

  // The bootstrap grant: the space's owner holds write and manage on the ROOT
  // folder, and everything beneath it is reached through the declared parent edge —
  // file → folder → folder → root. Nobody else holds either one, anywhere.
  for (const [p, t, s] of [
    [ada, tenant, scope],
    [cleo, otherTenant, otherScope],
  ] as const) {
    for (const permission of [DRIVE_PERM.write, DRIVE_PERM.manage]) {
      await host.admin.grant(staff, {
        principalId: p,
        permission,
        node: { tenantId: t, scopeId: s },
        entity: { entityType: 'folder', entityId: ROOT_FOLDER_ID },
        grantedBy: p,
      });
    }
  }
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('a space is a scope', () => {
  let documents: string;
  let scratch: string;
  let readme: string;

  it('the schema carries no space id — the conversion, in one assertion', () => {
    const sql = driveMigrations.map((m) => m.sql).join('\n');
    expect(sql).not.toMatch(/tenant_id|space_id/);
  });

  it('Ada creates a folder and writes a file into it', async () => {
    const folder = await (await host.getScope(ada, tenant, scope)).invoke<FolderRow>(
      'drive/create-folder',
      { parentId: ROOT_FOLDER_ID, name: 'Documents' },
    );
    documents = folder.id;
    expect(folder.path).toBe('Documents');

    const file = await write(ada, documents, 'readme.md', 'first draft');
    readme = file.id;
    expect(file.current_version_id).toBeTruthy();
  });

  it('the bytes come back, through the attachment the version names', async () => {
    const { version } = await (await host.getScope(ada, tenant, scope)).invoke<{
      version: VersionRow | null;
    }>('drive/get-file', { fileId: readme });
    expect(version?.source).toBe('blob');

    const attachments = await host.attachments(ada, tenant, scope);
    const opened = await attachments.open(version!.blob_ref!);
    expect(new TextDecoder().decode(opened!.body)).toBe('first draft');
    // The version's size is the byte length that was actually stored, not a number
    // the caller asserted — the two agreeing is what makes the row trustworthy.
    expect(version!.size).toBe(opened!.record.size);
  });

  it('writing the same name again supersedes: one file, two versions', async () => {
    const again = await write(ada, documents, 'readme.md', 'second draft, longer');
    expect(again.id).toBe(readme);

    const versions = await (await host.getScope(ada, tenant, scope)).invoke<{
      entries: VersionRow[];
    }>('drive/file-versions', { fileId: readme });
    expect(versions.entries).toHaveLength(2);

    // Newest first, and the two versions name DIFFERENT attachments: a write is never
    // an overwrite of the bytes the previous version points at, which is what makes
    // the version chain worth having.
    expect(versions.entries[0]!.id).toBe(again.current_version_id);
    expect(versions.entries[0]!.blob_ref).not.toBe(versions.entries[1]!.blob_ref);

    const attachments = await host.attachments(ada, tenant, scope);
    const previous = await attachments.open(versions.entries[1]!.blob_ref!);
    expect(new TextDecoder().decode(previous!.body)).toBe('first draft');
  });

  it('a version cannot name another file\'s bytes, or bytes that do not exist', async () => {
    const stub = await host.getScope(ada, tenant, scope);
    scratch = (
      await stub.invoke<FolderRow>('drive/create-folder', { parentId: ROOT_FOLDER_ID, name: 'Scratch' })
    ).id;
    const other = await write(ada, scratch, 'other.md', 'someone else\'s bytes');
    const { version: otherVersion } = await stub.invoke<{ version: VersionRow | null }>(
      'drive/get-file',
      { fileId: other.id },
    );

    // Ada may write to both files, so nothing here is about access — it is about a
    // version chain that records what actually happened. Pointing readme at other.md's
    // attachment would make its history a fiction.
    await expect(
      stub.invoke('drive/record-version', {
        fileId: readme,
        location: { source: 'blob', blobRef: otherVersion!.blob_ref! },
      }),
    ).rejects.toThrow(/another file/);

    await expect(
      stub.invoke('drive/record-version', {
        fileId: readme,
        location: { source: 'blob', blobRef: '01JZZZZZZZZZZZZZZZZZZZZZZZ' },
      }),
    ).rejects.toThrow();
  });

  it('a version describes the bytes that were stored, not what the caller claimed', async () => {
    const stub = await host.getScope(ada, tenant, scope);
    const file = await stub.invoke<FileRow>('drive/ensure-file', {
      folderId: scratch,
      name: 'derived.txt',
    });
    const body = new TextEncoder().encode('exactly twenty-one!!!');
    const attachment = await (await host.attachments(ada, tenant, scope)).upload({
      entity: { entityType: 'file', entityId: file.id },
      filename: 'derived.txt',
      contentType: 'text/plain',
      visibility: 'internal',
      body,
    });
    await stub.invoke('drive/record-version', {
      fileId: file.id,
      location: { source: 'blob', blobRef: attachment.id },
    });

    const { version } = await stub.invoke<{ version: VersionRow }>('drive/get-file', {
      fileId: file.id,
    });
    expect(version.size).toBe(body.byteLength);
    expect(version.mime).toBe('text/plain');
  });

  it('the folder listing is one hop, then a local query', async () => {
    const stub = await host.getScope(ada, tenant, scope);
    const page = await stub.invoke<{ entries: FileRow[] }>('drive/list-folder', {
      folderId: documents,
    });
    expect(page.entries.map((f) => f.name)).toEqual(['readme.md']);
  });

  it('a member reads the space drive, because membership is the grant', async () => {
    const stub = await host.getScope(bjorn, tenant, scope);
    const page = await stub.invoke<{ entries: FileRow[] }>('drive/list-folder', {
      folderId: documents,
    });
    expect(page.entries.map((f) => f.name)).toEqual(['readme.md']);
  });

  it('…and is refused the write nobody granted him', async () => {
    const stub = await host.getScope(bjorn, tenant, scope);
    await expect(
      stub.invoke('drive/ensure-file', { folderId: documents, name: 'notes.md' }),
    ).rejects.toThrow();
  });

  it('a reader may open the bytes; a member without write may not upload any', async () => {
    const { version } = await (await host.getScope(bjorn, tenant, scope)).invoke<{
      version: VersionRow | null;
    }>('drive/get-file', { fileId: readme });
    // Björn holds drive:read scope-wide, so the SAME key that lets him see the row
    // lets him open its bytes — the kernel checks the target's readPermission against
    // the owning file, and the drive holds no second rule about downloads.
    const readerBytes = await (await host.attachments(bjorn, tenant, scope)).open(version!.blob_ref!);
    expect(new TextDecoder().decode(readerBytes!.body)).toBe('second draft, longer');

    await expect(
      (await host.attachments(bjorn, tenant, scope)).upload({
        entity: { entityType: 'file', entityId: readme },
        filename: 'sneaky.md',
        contentType: 'text/markdown',
        visibility: 'internal',
        body: new TextEncoder().encode('nope'),
      }),
    ).rejects.toThrow();
  });

  it('a name carrying a path separator is refused, not concatenated', async () => {
    const stub = await host.getScope(ada, tenant, scope);
    // Without this rule "A/B" under the root would occupy the path of a real B
    // inside A while carrying the root's parent edge — the permission hierarchy
    // and the path hierarchy disagreeing, which is what the edge exists to prevent.
    await expect(
      stub.invoke('drive/create-folder', { parentId: ROOT_FOLDER_ID, name: 'A/B' }),
    ).rejects.toThrow();
    await expect(
      stub.invoke('drive/ensure-file', { folderId: documents, name: '  ' }),
    ).rejects.toThrow();
  });

  it("another tenant's scope shares no rows, not even the same paths", async () => {
    const stub = await host.getScope(cleo, otherTenant, otherScope);
    const folder = await stub.invoke<FolderRow>('drive/create-folder', {
      parentId: ROOT_FOLDER_ID,
      name: 'Documents',
    });
    const page = await stub.invoke<{ entries: FileRow[] }>('drive/list-folder', {
      folderId: folder.id,
    });
    expect(page.entries).toEqual([]);
  });
});
