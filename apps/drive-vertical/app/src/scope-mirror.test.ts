import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openDB } from 'idb';
import { clearMirror, indexedMirror, offlineIdentity, rememberOfflineIdentity, syncFromSpine, type MirrorStore } from './scope-mirror';
import type { DriveChange, DriveChanges, DriveFile, DriveFolder } from './api';

function memoryStore() {
  let cursor: string | null = null;
  let ready = false;
  const files = new Map<string, string>();
  const folders = new Map<string, string>();
  const store: MirrorStore = {
    async progress(principal) { return { principal, cursor, ready }; },
    async apply(_principal, page) {
      for (const change of page.changes) {
        const rows = change.entityType === 'file' ? files : folders;
        const row = change.entityType === 'file' ? change.file : change.folder;
        if (row) rows.set(change.entityId, row.name);
        else rows.delete(change.entityId);
      }
      cursor = page.cursor;
      ready ||= !page.hasMore;
    },
    async folder() { return null; },
  };
  return { store, files, folders, get cursor() { return cursor; }, get ready() { return ready; } };
}

describe('spine mirror sync', () => {
  it('applies file and folder pages, tombstones, and the last scanned cursor', async () => {
    const mirror = memoryStore();
    const calls: (string | null)[] = [];
    const pages: DriveChanges[] = [
      { cursor: '01J00000000000000000000001', hasMore: true, changes: [
        { id: '01J00000000000000000000001', type: 'drive.folder-created',
          entityType: 'folder', entityId: 'folder',
          folder: { id: 'folder', name: 'Docs', parent_id: 'root', path: 'Docs' } },
      ] },
      { cursor: '01J00000000000000000000002', hasMore: false, changes: [
        { id: '01J00000000000000000000002', type: 'drive.file-trashed',
          entityType: 'file', entityId: 'file', file: null },
      ] },
    ];
    mirror.files.set('file', 'Old');
    await syncFromSpine('person', mirror.store, async (after) => {
      calls.push(after);
      return pages.shift()!;
    });
    expect(calls).toEqual([null, '01J00000000000000000000001']);
    expect(mirror.folders.get('folder')).toBe('Docs');
    expect(mirror.files.has('file')).toBe(false);
    expect(mirror.cursor).toBe('01J00000000000000000000002');
    expect(mirror.ready).toBe(true);
  });

  it('resumes from the committed cursor after a failed page', async () => {
    const mirror = memoryStore();
    const first: DriveChanges = { cursor: '01J00000000000000000000001', hasMore: true, changes: [] };
    await expect(syncFromSpine('person', mirror.store, async (after) => {
      if (!after) return first;
      throw new Error('offline');
    })).rejects.toThrow('offline');
    expect(mirror.cursor).toBe(first.cursor);
    expect(mirror.ready).toBe(false);
    await syncFromSpine('person', mirror.store, async (after) => {
      expect(after).toBe(first.cursor);
      return { cursor: first.cursor, hasMore: false, changes: [] };
    });
    expect(mirror.ready).toBe(true);
  });

  it('refuses a non-advancing feed rather than looping forever', async () => {
    const mirror = memoryStore();
    await expect(syncFromSpine('person', mirror.store, async () => ({
      cursor: null, hasMore: true, changes: [],
    }))).rejects.toThrow(/did not advance/);
  });
});

describe('IndexedDB mirror', () => {
  const principal = 'person';
  const folder: DriveFolder = { id: 'docs', name: 'Docs', parent_id: 'root', path: 'Docs' };
  const file: DriveFile = {
    id: 'report', folder_id: 'docs', name: 'Report', current_version_id: null,
    created_at: '2026-09-01', updated_at: '2026-09-01', deleted_at: null,
  };
  const page = (cursor: string, changes: DriveChange[], hasMore = false): DriveChanges =>
    ({ cursor, changes, hasMore });
  const fileChange = (row: DriveFile | null): DriveChange =>
    ({ id: 'event', type: 'drive.file-updated', entityType: 'file', entityId: 'report', file: row });
  const folderChange = (row: DriveFolder | null): DriveChange =>
    ({ id: 'event', type: 'drive.folder-updated', entityType: 'folder', entityId: 'docs', folder: row });

  it('commits rows and cursor atomically, indexes folders, applies tombstones, and clears every principal', async () => {
    await indexedMirror.apply(principal, page('1', [folderChange(folder), fileChange(file)], true), null, 0);
    expect(await indexedMirror.folder(principal, 'docs')).toBeNull(); // Initial sync is incomplete.
    await rememberOfflineIdentity('https://drive.test|home', principal);
    expect(await offlineIdentity('https://drive.test|home')).toBeNull();
    await indexedMirror.apply(principal, page('2', [], false), '1', 0);
    expect(await offlineIdentity('https://drive.test|home')).toBe(principal);
    expect(await indexedMirror.folder(principal, 'docs')).toEqual({ files: [file], folders: [] });
    expect(await indexedMirror.folder(principal, 'root')).toEqual({ files: [], folders: [folder] });
    await expect(indexedMirror.apply(principal, page('stale', [fileChange({ ...file, name: 'Old tab' })]), '1', 0))
      .rejects.toThrow(/advanced the mirror cursor/);
    expect((await indexedMirror.progress(principal))?.cursor).toBe('2');
    expect((await indexedMirror.folder(principal, 'docs'))?.files).toEqual([file]);

    // The first write must roll back with the cursor when a later row has an invalid key.
    const badFile = { ...file, id: undefined } as unknown as DriveFile;
    await expect(indexedMirror.apply(principal, page('3', [
      fileChange({ ...file, name: 'Changed' }), fileChange(badFile),
    ]), '2', 0)).rejects.toThrow();
    expect((await indexedMirror.progress(principal))?.cursor).toBe('2');
    expect((await indexedMirror.folder(principal, 'docs'))?.files).toEqual([file]);

    await indexedMirror.apply(principal, page('3', [fileChange(null), folderChange(null)]), '2', 0);
    expect(await indexedMirror.folder(principal, 'docs')).toEqual({ files: [], folders: [] });
    expect(await indexedMirror.folder(principal, 'root')).toEqual({ files: [], folders: [] });
    await indexedMirror.apply('other', page('1', [fileChange(file)]), null, 0);

    expect(await offlineIdentity('https://drive.test|home')).toBe(principal);
    expect(await offlineIdentity('https://drive.test|family')).toBeNull();

    await clearMirror();
    expect(await offlineIdentity('https://drive.test|home')).toBeNull();
    const database = await openDB('canopy.scope-mirror', 1);
    expect(await database.getAll('files')).toEqual([]);
    expect(await database.getAll('folders')).toEqual([]);
    expect((await database.getAll('progress')).map((row: { principal: string }) => row.principal))
      .toEqual(['__mirror_session__']);
    await expect(indexedMirror.apply(principal, page('4', [fileChange(file)]), '3', 0))
      .rejects.toThrow(/session ended/);
  });
});
