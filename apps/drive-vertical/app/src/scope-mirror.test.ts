import { describe, expect, it } from 'vitest';
import { syncFromSpine, type MirrorStore } from './scope-mirror';
import type { DriveChanges } from './api';

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
