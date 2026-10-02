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
      'DELETE /api/folders/:folderId/shares',
      'GET /api/changes',
      'GET /api/files/:fileId',
      'GET /api/files/:fileId/text',
      'GET /api/files/:fileId/versions',
      'GET /api/files/:fileId/versions/:versionId',
      'GET /api/folders/:folderId/files',
      'GET /api/folders/:folderId/folders',
      'GET /api/folders/:folderId/shares',
      'GET /api/folders/by-path',
      'GET /api/folders/shared-with-me',
      'GET /api/people',
      'GET /api/people/access',
      'GET /api/search',
      'GET /api/trash',
      'PATCH /api/files/:fileId',
      'PATCH /api/folders/:folderId',
      'POST /api/files/:fileId/move',
      'POST /api/files/:fileId/restore',
      'POST /api/files/:fileId/versions',
      'POST /api/files/:fileId/versions/:versionId/restore',
      'POST /api/folders/:folderId/files',
      'POST /api/folders/:folderId/move',
      'POST /api/folders/:folderId/shares',
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
    /**
     * The OPERATION, not the path. My first version of this matched path substrings, which
     * pins a spelling rather than the property: an `http` block mounting
     * `drive/record-person` at `/api/me/identity` would have passed it. Each mounted route
     * carries the operation it serves, so that is what gets asserted.
     */
    const operations = mounted.map((r) => r.operation);
    expect(operations).not.toContain('drive/record-person');
    expect(operations).not.toContain('drive/record-text');
    expect(operations).not.toContain('drive/forget-person');
  });
});
