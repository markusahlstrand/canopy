import type { Db } from "./db";
import type { Connection } from "./types";
import type { FileService, ReconcileConnector } from "./files";
import { listAllConnections, listConnectionsByType, startIndexRun, finishIndexRun, failIndexRun } from "./connections";

/**
 * Keep a connected space's index fresh. The reconcile primitive (one folder) lives
 * on {@link FileService}; this orchestrates it across a tree:
 *
 *  • {@link crawlConnector} — bounded breadth-first reconcile from the root. Used for
 *    the initial population and as the safety-net sweep (it converges deletes too,
 *    since a reconcile of a folder tombstones whatever the connector no longer lists).
 *  • {@link syncConnection} — one connection: prefer the connector's change feed
 *    (reconcile just the folders touched since the last run), else crawl. Then drain
 *    the extract queue and advance the run cursor.
 *  • {@link syncAllConnectors} — every connection of a type (the cron / interval entry).
 */

/** Folders we reconcile per crawl, so one sweep can't run unbounded over a huge tree. */
const MAX_FOLDERS_PER_CRAWL = 500;
/** Files whose text we pull + index per sweep. */
const SWEEP_DRAIN_LIMIT = 50;

export interface SweepDeps {
  db: Db;
  service: FileService;
  /** Build the owner's connector for a plugin (decrypts settings; container path on the edge). */
  connectorForUser: (sub: string, pluginId: string) => Promise<ReconcileConnector | null>;
}

export interface CrawlTarget {
  ownerSub: string;
  spaceId: string;
  pluginId: string;
}

/** The immediate parent folder of a connector path ("" for a root-level entry). */
function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "" : path.slice(0, i);
}

/** Breadth-first reconcile of a connector tree, bounded to `limit` folders. Returns the count visited. */
export async function crawlConnector(
  service: FileService,
  target: CrawlTarget,
  connector: ReconcileConnector,
  limit = MAX_FOLDERS_PER_CRAWL,
): Promise<number> {
  const queue: string[] = [""];
  const seen = new Set<string>();
  let visited = 0;
  while (queue.length && visited < limit) {
    const dir = queue.shift()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    const { folders } = await service.reconcileConnectorFolder(target.ownerSub, target.spaceId, target.pluginId, connector, dir);
    visited++;
    for (const sub of folders) if (!seen.has(sub)) queue.push(sub);
  }
  return visited;
}

/**
 * Sync one connection. With a change feed + a prior cursor, reconcile only the
 * folders touched since (a delete/rename/add bumps its parent dir's mtime, so the
 * feed surfaces the folders to revisit and the per-folder diff converges them).
 * Otherwise crawl the tree. Then drain extraction and advance the cursor.
 */
export async function syncConnection(deps: SweepDeps, conn: Connection): Promise<{ folders: number }> {
  const connector = await deps.connectorForUser(conn.ownerId, conn.type);
  if (!connector) return { folders: 0 };
  const target: CrawlTarget = { ownerSub: conn.ownerId, spaceId: conn.id, pluginId: conn.type };
  const run = await startIndexRun(deps.db, conn.id);
  let folders = 0;
  let highWater = run.cursor ? Number(run.cursor) : 0;
  try {
    if (connector.changes && run.cursor) {
      const affected = new Set<string>();
      for await (const ev of connector.changes(run.cursor)) {
        affected.add(parentDir(ev.path));
        if (ev.entry?.kind === "folder") affected.add(ev.path);
        const m = ev.entry?.modifiedAt ? Math.floor(Date.parse(ev.entry.modifiedAt) / 1000) : 0;
        if (Number.isFinite(m) && m > highWater) highWater = m;
      }
      for (const dir of affected) {
        await deps.service.reconcileConnectorFolder(target.ownerSub, target.spaceId, target.pluginId, connector, dir);
        folders++;
      }
    } else {
      folders = await crawlConnector(deps.service, target, connector);
      highWater = Math.floor(Date.now() / 1000);
    }
    await deps.service.drainExternalExtractQueue(SWEEP_DRAIN_LIMIT);
    const cursor = String(highWater || Math.floor(Date.now() / 1000));
    await finishIndexRun(deps.db, run.id, { cursor, filesSeen: folders });
  } catch (err) {
    await failIndexRun(deps.db, run.id, (err as Error).message);
    throw err;
  }
  return { folders };
}

/**
 * Sweep connections (the cron / interval entry point). With `type`, only that
 * connector's connections; without it, every connector-backed space regardless of
 * type (so a GitHub repo gets the same safety-net refresh as a NAS). Per-connection
 * failures are isolated.
 */
export async function syncAllConnectors(deps: SweepDeps, type?: string): Promise<void> {
  const conns = type ? await listConnectionsByType(deps.db, type) : await listAllConnections(deps.db);
  for (const conn of conns) {
    try {
      await syncConnection(deps, conn);
    } catch (err) {
      console.warn(`[sweep] connection ${conn.id} failed: ${(err as Error).message}`);
    }
  }
}
