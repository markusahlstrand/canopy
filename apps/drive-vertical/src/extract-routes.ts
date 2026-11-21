import type { Context, Env, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { isLockedName } from './editable-text.js';

export interface ExtractRouteScope {
  invoke<T>(operation: string, input?: Record<string, unknown>): Promise<T>;
}

/** What the route acts with: the space as the caller, and the seams that queue runs. */
export interface ExtractAccess {
  scope: ExtractRouteScope;
  /** Null when entity extraction can run here; otherwise why not, in words for the person who asked. */
  unavailable(): Promise<string | null>;
  /**
   * Queue runs, then drive due runs after the response. `manual` reads again even a version
   * already read (one file, from its menu); otherwise a version already read is skipped, so a
   * folder can be asked for twice without paying twice.
   */
  queue(files: readonly { id: string }[], manual: boolean): Promise<void>;
}

/** How many files one folder request queues. The rest are reported, and a second request picks them up. */
export const EXTRACT_FOLDER_MAX = 200;
const PAGE = 500;

const input = z.union([
  z.object({ fileId: z.string().min(1) }).strict(),
  z.object({ folderId: z.string().min(1), after: z.string().min(1).optional() }).strict(),
]);

export interface ExtractResult { queued: number; skipped: number; more: boolean; next?: string }

interface SubtreeEntry { id: string; name: string; current_version_id: string | null }

/**
 * Entity extraction on request, from a file's or a folder's menu — the way to read files that
 * were there before the space turned it on. The space's opt-in still decides.
 */
export function mountExtract<E extends Env>(app: Hono<E>, resolve: (c: Context<E>) => Promise<ExtractAccess>) {
  app.post('/api/extract-entities', async (c) => {
    const parsed = input.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: 'Say which file or folder to read.' });
    const access = await resolve(c);
    const why = await access.unavailable();
    if (why) throw new HTTPException(409, { message: why });

    if ('fileId' in parsed.data) {
      const { file, canWrite } = await access.scope.invoke<{ file: { id: string; name: string }; canWrite: boolean }>(
        'drive/get-file', { fileId: parsed.data.fileId },
      );
      if (!canWrite) throw new HTTPException(403, { message: 'You can’t change this file.' });
      if (isLockedName(file.name)) throw new HTTPException(409, { message: 'This file is encrypted, so its text can’t be read.' });
      await access.queue([file], true);
      return c.json({ queued: 1, skipped: 0, more: false } satisfies ExtractResult, 202);
    }

    const { folderId } = parsed.data;
    let after = parsed.data.after;
    const folder = await access.scope.invoke<{ canWrite: boolean }>('drive/get-folder', { folderId });
    if (!folder.canWrite) throw new HTTPException(403, { message: 'You can’t change files in this folder.' });
    const picked: SubtreeEntry[] = [];
    let skipped = 0;
    let more = false;
    do {
      const page = await access.scope.invoke<{ entries: SubtreeEntry[]; next: string | null }>(
        'drive/list-subtree-files', { folderId, limit: PAGE, ...(after ? { after } : {}) },
      );
      for (const entry of page.entries) {
        if (isLockedName(entry.name) || !entry.current_version_id) skipped++;
        else if (picked.length < EXTRACT_FOLDER_MAX) picked.push(entry);
        else more = true;
      }
      after = page.next ?? undefined;
    } while (after && !more);
    if (after) more = true;
    if (picked.length) await access.queue(picked, false);
    const next = more ? picked.at(-1)?.id ?? after : undefined;
    return c.json({ queued: picked.length, skipped, more, ...(next ? { next } : {}) } satisfies ExtractResult, 202);
  });
}
