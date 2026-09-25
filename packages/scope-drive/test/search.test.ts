/**
 * Finding a file by what is INSIDE it (S9b, #56).
 *
 * Three claims, one per acceptance bullet on the ticket, plus the one the ticket
 * states as a constraint rather than a bullet:
 *
 *  1. a phrase from a document's body finds the file that holds it
 *  2. "no extractable text" is distinguishable from "never extracted"
 *  3. a hit is gated by the same permission that gates opening the file
 *
 * The extraction itself is the host's job and is not exercised here — this is
 * about what the SCOPE does with the text once it has it, which is the half that
 * has to be right for the other half to be worth writing.
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
/** Holds the root: makes the world, reads everything. */
const ada = principalId.parse(ulid());
/** A member — which in this drive means read across the whole space. */
const bjorn = principalId.parse(ulid());
/** NOT a member: one folder grant and nothing at the node. */
const cleo = principalId.parse(ulid());

interface FileRow {
  id: string;
  name: string;
  folder_id: string;
}
interface FolderRow {
  id: string;
  path: string;
  name: string;
}
interface TextRow {
  status: string;
  chars: number;
  detail: string | null;
}
interface Hits {
  hits: (FileRow & { via: 'name' | 'content' })[];
}

const as = (who: typeof ada) => host.getScope(who, tenant, scope);

/**
 * A file with bytes behind it — which is what extraction is ever about.
 *
 * `drive/record-text` only accepts text describing the file's CURRENT version, so
 * a test that skipped the version would be recording against nothing and would
 * pass for the wrong reason. `external` rather than `blob`: no attachment store
 * is involved in what these tests assert.
 */
async function fileWithVersion(
  stub: Awaited<ReturnType<typeof as>>,
  folderId: string,
  name: string,
): Promise<{ id: string; versionId: string }> {
  const file = await stub.invoke<FileRow>('drive/ensure-file', { folderId, name });
  const written = await stub.invoke<{ current_version_id: string }>('drive/record-version', {
    fileId: file.id,
    location: { source: 'external', externalKey: name, mime: 'application/pdf', size: 1 },
  });
  return { id: file.id, versionId: written.current_version_id };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'canopy-drive-search-'));
  host = new SqliteScopeHost({ dir });
  host.registerModule(driveModule);

  await host.admin.createTenant(staff, { id: tenant, slug: 'search', name: 'Search' });
  await host.admin.grantEntitlement(staff, tenant, driveManifest.entitlementKey as string);
  await host.provisionScope(staff, { tenantId: tenant, scopeId: scope, vertical: 'drive' });
  await host.provisionBlobStore(staff, { tenantId: tenant, vertical: 'drive', binding: 'BLOBS' });
  await host.admin.activateScope(staff, tenant, scope);
  for (const role of ROLES) await host.admin.defineRole(staff, tenant, role);
  for (const p of [ada, bjorn]) {
    await host.admin.assignRole(staff, { principalId: p, roleKey: 'member', node: { tenantId: tenant, scopeId: scope } });
  }
  for (const permission of [DRIVE_PERM.write, DRIVE_PERM.manage]) {
    await host.admin.grant(staff, {
      principalId: ada,
      permission,
      node: { tenantId: tenant, scopeId: scope },
      entity: { entityType: 'folder', entityId: ROOT_FOLDER_ID },
      grantedBy: ada,
    });
  }
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('a file is findable by what is inside it', () => {
  let shared: string;
  let secret: string;
  let quarterly: string;
  let scanned: string;

  beforeAll(async () => {
    const stub = await as(ada);
    shared = (await stub.invoke<FolderRow>('drive/create-folder', { parentId: ROOT_FOLDER_ID, name: 'Shared' })).id;
    secret = (await stub.invoke<FolderRow>('drive/create-folder', { parentId: ROOT_FOLDER_ID, name: 'Secret' })).id;

    const q = await fileWithVersion(stub, shared, 'quarterly.pdf');
    quarterly = q.id;
    await stub.invoke('drive/record-text', {
      fileId: quarterly,
      versionId: q.versionId,
      status: 'indexed',
      text: 'Revenue grew by eleven percent across the Nordic region.',
    });

    // Same phrase, in a folder Bjorn cannot reach. If a hit leaks, this is what
    // it leaks — the existence of a document, which is the whole of the risk.
    const hidden = await fileWithVersion(stub, secret, 'board.pdf');
    await stub.invoke('drive/record-text', {
      fileId: hidden.id,
      versionId: hidden.versionId,
      status: 'indexed',
      text: 'Revenue grew by eleven percent, and the board was not pleased.',
    });

    // Extraction ran and found nothing — a scan with no OCR.
    const sc = await fileWithVersion(stub, shared, 'scanned.pdf');
    scanned = sc.id;
    await stub.invoke('drive/record-text', {
      fileId: scanned,
      versionId: sc.versionId,
      status: 'empty',
      detail: 'no text layer',
    });

    // …and `untouched.pdf` gets NO record-text call at all. That is the fifth state.
    await stub.invoke('drive/ensure-file', { folderId: shared, name: 'untouched.pdf' });

    // Cleo holds one folder and no role — the shape a share link or an outside
    // collaborator arrives as.
    await host.admin.grant(staff, {
      principalId: cleo,
      permission: DRIVE_PERM.read,
      node: { tenantId: tenant, scopeId: scope },
      entity: { entityType: 'folder', entityId: shared },
      grantedBy: ada,
    });
  });

  it('finds a file by a phrase from its body', async () => {
    const { hits } = await (await as(ada)).invoke<Hits>('drive/search', { term: 'Nordic region' });
    const hit = hits.find((h) => h.id === quarterly);
    expect(hit).toBeDefined();
    expect(hit!.via).toBe('content');
  });

  it('finds a file by its name, and says which index answered', async () => {
    const { hits } = await (await as(ada)).invoke<Hits>('drive/search', { term: 'quarterly' });
    expect(hits.find((h) => h.id === quarterly)?.via).toBe('name');
  });

  it('tells "nothing to extract" apart from "never extracted"', async () => {
    const stub = await as(ada);

    // Looked at, and there was genuinely nothing there.
    const looked = await stub.invoke<TextRow | null>('drive/file-text', { fileId: scanned });
    expect(looked?.status).toBe('empty');
    expect(looked?.detail).toBe('no text layer');
    expect(looked?.chars).toBe(0);

    // Never looked at. The same "no results" to a naive UI, a different fact.
    const untouched = (
      await stub.invoke<{ entries: FileRow[] }>('drive/list-folder', { folderId: shared })
    ).entries.find((f) => f.name === 'untouched.pdf')!;
    expect(await stub.invoke<TextRow | null>('drive/file-text', { fileId: untouched.id })).toBeNull();
  });

  it('lets a member search the whole space, because membership is the grant', async () => {
    // Not a compromise — the drive's model. `member` holds `drive:read` at the
    // NODE, so a member already reads every file in the space through
    // `drive/list-folder`; a search that hid half of them would be inventing a
    // boundary the rest of the drive does not have.
    const mine = await (await as(ada)).invoke<Hits>('drive/search', { term: 'eleven percent' });
    expect(mine.hits.length).toBe(2);

    const theirs = await (await as(bjorn)).invoke<Hits>('drive/search', { term: 'eleven percent' });
    expect(theirs.hits.map((h) => h.id).sort()).toEqual(mine.hits.map((h) => h.id).sort());
  });

  it('does not let a folder grant alone buy a search of the space', async () => {
    // Cleo is NOT a member: she holds `drive:read` on one folder and nothing at
    // the node. She can open what she was given…
    const stub = await as(cleo);
    await expect(stub.invoke('drive/get-file', { fileId: quarterly })).resolves.toBeDefined();

    // …and cannot ask the space a question. This is the boundary that keeps a
    // ranked list from being an enumeration tool for someone holding one folder:
    // the per-hit check in the handler is the second line, and this is the first.
    await expect(stub.invoke('drive/search', { term: 'eleven percent' })).rejects.toThrow();
  });

  it('keeps a file with no text layer out of the content index', async () => {
    const { hits } = await (await as(ada)).invoke<Hits>('drive/search', { term: 'scanned' });
    // Found by NAME — the row exists and is `empty`, so there is nothing to match
    // on in the body, and the name index is what answers.
    expect(hits.find((h) => h.id === scanned)?.via).toBe('name');
  });
  it('replaces a file\'s text rather than accumulating it', async () => {
    const stub = await as(ada);
    const written = await stub.invoke<{ current_version_id: string }>('drive/record-version', {
      fileId: quarterly,
      location: { source: 'external', externalKey: 'q2', mime: 'application/pdf', size: 1 },
    });
    const v2 = written.current_version_id;
    await stub.invoke('drive/record-text', {
      fileId: quarterly,
      versionId: v2,
      status: 'indexed',
      text: 'Revenue fell in the Baltic region.',
    });

    const now = await stub.invoke<TextRow & { version_id: string }>('drive/file-text', { fileId: quarterly });
    expect(now.version_id).toBe(v2);

    // The superseded text is out of the index, not merely outranked by the new.
    const stale = await stub.invoke<Hits>('drive/search', { term: 'Nordic region' });
    expect(stale.hits.map((h) => h.id)).not.toContain(quarterly);

    const fresh = await stub.invoke<Hits>('drive/search', { term: 'Baltic' });
    expect(fresh.hits.find((h) => h.id === quarterly)?.via).toBe('content');
  });

  it('refuses text about a version the file has moved off', async () => {
    // The race the upload path makes real: extraction runs off the request, so a
    // big file uploaded first can still be parsing when a small one lands after
    // it. Without the guard the slow, OLDER extraction lands last and silently
    // replaces the newer text — a wrong answer shaped exactly like a right one.
    const stub = await as(ada);
    const f = await fileWithVersion(stub, shared, 'raced.pdf');
    await stub.invoke('drive/record-text', {
      fileId: f.id,
      versionId: f.versionId,
      status: 'indexed',
      text: 'The second version, which is the one that counts.',
    });

    // A v1 extraction finishing late, after v2 already became current. Refused,
    // and refused as a CONFLICT — the upload path reads that code and treats it
    // as the ordinary outcome it is rather than as an extraction failure.
    await expect(
      stub.invoke('drive/record-text', {
        fileId: f.id,
        versionId: ulid(),
        status: 'indexed',
        text: 'The first version, which arrived late and must not win.',
      }),
    ).rejects.toThrow();

    const now = await stub.invoke<TextRow & { version_id: string }>('drive/file-text', {
      fileId: f.id,
    });
    expect(now.version_id).toBe(f.versionId);

    const hits = await stub.invoke<Hits>('drive/search', { term: 'arrived late' });
    expect(hits.hits.map((h) => h.id)).not.toContain(f.id);
    const kept = await stub.invoke<Hits>('drive/search', { term: 'one that counts' });
    expect(kept.hits.find((h) => h.id === f.id)?.via).toBe('content');
  });

  /**
   * The two reads a path-addressed caller needs (S12). The portal browses by path and
   * shows folders beside files; the drive had neither read, because its own front end
   * navigates by id and lists only files.
   */
  it('lists the folders directly inside a folder', async () => {
    const stub = await as(ada);
    const parent = await stub.invoke<FolderRow>('drive/create-folder', {
      parentId: ROOT_FOLDER_ID,
      name: 'Projects',
    });
    await stub.invoke('drive/create-folder', { parentId: parent.id, name: 'Alpha' });
    await stub.invoke('drive/create-folder', { parentId: parent.id, name: 'Beta' });
    // A folder elsewhere, to prove the filter is the parent and not "every folder".
    await stub.invoke('drive/create-folder', { parentId: ROOT_FOLDER_ID, name: 'Elsewhere' });

    const page = await stub.invoke<{ entries: { name: string }[] }>('drive/list-folders', {
      folderId: parent.id,
    });
    expect(page.entries.map((f) => f.name).sort()).toEqual(['Alpha', 'Beta']);
  });

  it('resolves a folder by its path', async () => {
    const stub = await as(ada);
    const found = await stub.invoke<FolderRow | null>('drive/folder-by-path', { path: 'Shared' });
    expect(found?.id).toBe(shared);
    expect(found?.path).toBe('Shared');
  });

  it('answers null for a path that is not there', async () => {
    const stub = await as(ada);
    expect(await stub.invoke('drive/folder-by-path', { path: 'Nowhere/At/All' })).toBeNull();
  });

  it('answers the same null for a folder the caller may not read', async () => {
    // The point of the pair: Cleo holds a grant on `Shared` and nothing else. If a
    // refusal raised while a miss answered null, she could walk the tree she cannot
    // read one guess at a time — "Secret" would answer differently from "Nowhere".
    const stub = await as(cleo);
    expect(await stub.invoke('drive/folder-by-path', { path: 'Shared' })).not.toBeNull();

    const refused = await stub.invoke('drive/folder-by-path', { path: 'Secret' });
    const missing = await stub.invoke('drive/folder-by-path', { path: 'Nowhere' });
    expect(refused).toBeNull();
    expect(refused).toEqual(missing);
  });
});
