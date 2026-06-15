import { crawlConnector, type CrawlTarget, type SweepDeps } from "./connector-sync";
import { failIndexRun, finishIndexRun, getConnection, startIndexRun } from "./connections";
import type { IndexJobs } from "./index-jobs";

/**
 * In-process {@link IndexJobs} for Node / self-host (and the Cloudflare fallback when
 * no Workflow/Queue bindings are present). The caller backgrounds `startConnectorIndex`
 * (`waitUntil` on a Worker, fire-and-forget on Node), so it can run to completion off
 * the response path.
 *
 * Unlike the bounded safety-net sweep ({@link import("./connector-sync").syncConnection}),
 * this does a FULL crawl — Node isn't subrequest/CPU-constrained, so we index the whole
 * tree in one pass — then drains extraction in batches until the pending queue is empty.
 * It records progress as an `index_runs` row, exactly like the sweep, so the two share
 * the cursor and re-runs stay idempotent (reconcile is an etag diff).
 */
export function inProcessIndexJobs(deps: SweepDeps): IndexJobs {
  /** Effectively unbounded crawl — Node has no per-invocation budget like the Worker. */
  const FULL_CRAWL_LIMIT = 100_000;
  const DRAIN_BATCH = 50;
  /** Cap drain iterations so a stuck extractor can't spin forever (≈ 10k files). */
  const MAX_DRAIN_BATCHES = 200;

  async function fullIndex(target: CrawlTarget): Promise<void> {
    const conn = await getConnection(deps.db, target.spaceId);
    if (!conn) return;
    const connector = await deps.connectorForUser(conn.ownerId, conn.type);
    if (!connector) return;
    const run = await startIndexRun(deps.db, conn.id);
    try {
      const folders = await crawlConnector(deps.service, target, connector, FULL_CRAWL_LIMIT);
      for (let i = 0; i < MAX_DRAIN_BATCHES; i++) {
        const { extracted, failed } = await deps.service.drainExternalExtractQueue(DRAIN_BATCH);
        if (extracted + failed === 0) break; // nothing left pending
      }
      await finishIndexRun(deps.db, run.id, { cursor: String(Math.floor(Date.now() / 1000)), filesSeen: folders });
    } catch (err) {
      await failIndexRun(deps.db, run.id, (err as Error).message);
      throw err;
    }
  }

  return {
    startConnectorIndex: fullIndex,
    async enqueueExtract() {
      // Node isn't budget-constrained — just drain inline (a no-op when nothing's pending).
      await deps.service.drainExternalExtractQueue(DRAIN_BATCH);
    },
  };
}
