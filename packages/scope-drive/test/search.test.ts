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

    quarterly = (await stub.invoke<FileRow>('drive/ensure-file', { folderId: shared, name: 'quarterly.pdf' })).id;
    await stub.invoke('drive/record-text', {
      fileId: quarterly,
      versionId: ulid(),
      status: 'indexed',
      text: 'Revenue grew by eleven percent across the Nordic region.',
    });

    // Same phrase, in a folder Bjorn cannot reach. If a hit leaks, this is what
    // it leaks — the existence of a document, which is the whole of the risk.
    const hidden = (await stub.invoke<FileRow>('drive/ensure-file', { folderId: secret, name: 'board.pdf' })).id;
    await stub.invoke('drive/record-text', {
      fileId: hidden,
      versionId: ulid(),
      status: 'indexed',
      text: 'Revenue grew by eleven percent, and the board was not pleased.',
    });

    // Extraction ran and found nothing — a scan with no OCR.
    scanned = (await stub.invoke<FileRow>('drive/ensure-file', { folderId: shared, name: 'scanned.pdf' })).id;
    await stub.invoke('drive/record-text', {
      fileId: scanned,
      versionId: ulid(),
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
    const v2 = ulid();
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
});
