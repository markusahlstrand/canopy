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
      'GET /api/files/:fileId',
      'GET /api/files/:fileId/text',
      'GET /api/files/:fileId/versions',
      'GET /api/folders/:folderId/files',
      'GET /api/search',
      'POST /api/files/:fileId/versions',
      'POST /api/folders/:folderId/files',
      'POST /api/folders/:parentId/folders',
    ]);
  });
});
