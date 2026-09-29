/**
 * The HTTP surface, pinned.
 *
 * `mountOperations` derives the table from each operation's `http`, which is the
 * point — but a derived table that mounted nothing, moved a path or changed a verb
 * would pass every other test in this package, because the scenario suite calls
 * operations directly and never boots a host.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mountApi } from '../src/routes.js';

describe('the derived route table', () => {
  it('mounts one route per operation that declares a URL', () => {
    const mounted = mountApi(new Hono(), async () => {
      throw new Error('not reached: this test never resolves a stub');
    });
    // `/api` and Hono's `:param` spelling are the platform's, not ours — the
    // declaration carries `/folders/{folderId}/files` and the mount decides how that
    // reaches a router. Pinning what it actually mounted is the point.
    expect(mounted.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'DELETE /api/files/:fileId',
      'GET /api/files/:fileId',
      'GET /api/files/:fileId/text',
      'GET /api/files/:fileId/versions',
      'GET /api/folders/:folderId/files',
      'GET /api/folders/:folderId/folders',
      'GET /api/folders/by-path',
      'GET /api/people',
      'GET /api/people/access',
      'GET /api/search',
      'GET /api/trash',
      'PATCH /api/files/:fileId',
      'PATCH /api/folders/:folderId',
      'POST /api/files/:fileId/move',
      'POST /api/files/:fileId/restore',
      'POST /api/files/:fileId/versions',
      'POST /api/folders/:folderId/files',
      'POST /api/folders/:folderId/move',
      'POST /api/folders/:parentId/folders',
    ]);
  });

  /**
   * The operations that must NOT be reachable over HTTP, named rather than merely absent
   * from the list above.
   *
   * Both are writes whose authority comes from something the caller cannot be trusted to
   * assert about itself: `record-person` writes a display identity that only the worker's
   * verified session knows, and `record-text` writes extraction output about a version.
   * Adding an `http` block to either would pass the assertion above by simply appearing in
   * it, so the property is stated on its own.
   */
  it('mounts no route for the operations only the worker may invoke', () => {
    const mounted = mountApi(new Hono(), async () => {
      throw new Error('not reached: this test never resolves a stub');
    });
    const paths = mounted.map((r) => r.path);
    expect(paths).not.toContain('/api/people/record');
    // Nothing anywhere in the table may reach them, however it is spelled.
    for (const forbidden of ['record-person', 'record-text', 'record_person']) {
      expect(paths.filter((path) => path.includes(forbidden))).toEqual([]);
    }
  });
});
