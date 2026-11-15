import type { Context, Env, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { isLockedName } from './editable-text.js';

export interface LabelScope {
  invoke<T>(operation: string, input?: Record<string, unknown>): Promise<T>;
}

/** What the route acts with: the space as the caller, and the one seam that queues a manual run. */
export interface LabelAccess {
  scope: LabelScope;
  /** Null when Document AI can run here; otherwise why not, in words for the person who asked. */
  unavailable(): Promise<string | null>;
  /** Queue a manual run for each file (its own instance, no cooldown), then drive due runs after the response. */
  queue(files: readonly { id: string }[]): Promise<void>;
}

/** How many files one folder request queues. The rest are reported, and a second request picks them up. */
export const LABEL_FOLDER_MAX = 200;
const PAGE = 500;

const input = z.union([
  z.object({ fileId: z.string().min(1) }).strict(),
  z.object({ folderId: z.string().min(1), relabel: z.boolean().optional(), after: z.string().min(1).optional() }).strict(),
]);

export interface LabelResult {
  /** Files a run was queued (or joined) for. */
  queued: number;
  /** Files left alone: already labelled (unless `relabel`), or encrypted. */
  skipped: number;
  /** More files are waiting under the folder than one request queues. */
  more: boolean;
  /** Where the next request picks up (`after`) — present exactly when `more` is. */
  next?: string;
}

interface SubtreeEntry { id: string; name: string; labels: string[] }

/**
 * Document AI on request, from a file's or folder's menu.
 *
 * The space's opt-in still decides: a menu click is one person's request, and sending the
 * space's documents to a model is its administrator's call. Past that, a manual run skips the
 * cooldown and answers again about a version already answered, which is what asking means.
 *
 * A folder queues the files under it that have no labels yet — or all of them with `relabel` —
 * up to `LABEL_FOLDER_MAX` per request; `next` names where the following request (`after`) picks up. The run itself checks each file can still be written
 * as the caller, so a file they may only read is skipped there, not here.
 */
export function mountLabel<E extends Env>(app: Hono<E>, resolve: (c: Context<E>) => Promise<LabelAccess>) {
  app.post('/api/label', async (c) => {
    const parsed = input.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: 'Say which file or folder to label.' });
    const access = await resolve(c);
    const why = await access.unavailable();
    if (why) throw new HTTPException(409, { message: why });

    if ('fileId' in parsed.data) {
      const { file, canWrite } = await access.scope.invoke<{ file: { id: string; name: string }; canWrite: boolean }>(
        'drive/get-file', { fileId: parsed.data.fileId },
      );
      if (!canWrite) throw new HTTPException(403, { message: 'You can’t change this file’s details.' });
      if (isLockedName(file.name)) throw new HTTPException(409, { message: 'This file is encrypted, so its text can’t be read.' });
      await access.queue([file]);
      return c.json({ queued: 1, skipped: 0, more: false } satisfies LabelResult, 202);
    }

    const { folderId, relabel } = parsed.data;
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
        if (isLockedName(entry.name) || (!relabel && entry.labels.length > 0)) skipped++;
        else if (picked.length < LABEL_FOLDER_MAX) picked.push(entry);
        else more = true;
      }
      after = page.next ?? undefined;
    } while (after && !more);
    if (after) more = true;
    if (picked.length) await access.queue(picked);
    // The listing is ordered by file id, so the last file taken is where the next request starts:
    // without it a re-label of every file would take the same first files each time.
    const next = more ? picked.at(-1)?.id ?? after : undefined;
    return c.json({ queued: picked.length, skipped, more, ...(next ? { next } : {}) } satisfies LabelResult, 202);
  });
}
