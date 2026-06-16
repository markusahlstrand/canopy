import type { CrawlTarget } from "./connector-sync";

/**
 * Background-work port for connector indexing — the seam that lets the same trigger
 * code run on different runtimes. On Cloudflare it's backed by a Workflow (the durable,
 * resumable crawl) + a Queue (the order-independent text-extract fan-out); on Node /
 * self-host it's an in-process loop (see {@link inProcessIndexJobs}) over the same
 * `crawlConnector` / `reconcileConnectorFolder` / `drainExternalExtractQueue` primitives.
 * Selected once at composition time (worker.ts / node.ts), like the `DocWorker` adapter.
 *
 * Structural + serializable (no Cloudflare / `@canopy/core` types), mirroring how
 * `DocumentTextExtractor` / `ReconcileConnector` are declared in files.ts.
 */
export interface IndexJobs {
  /**
   * Index a whole connector: crawl its tree, upserting external file rows into the DB,
   * and drain text extraction. Idempotent per target — a second call for an in-flight
   * target coalesces (the CF Workflow keys its instance by `spaceId`; the in-process
   * runner dedups via the `index_runs` cursor). The caller backgrounds this
   * (`waitUntil` on a Worker, fire-and-forget on Node) — it never blocks a response.
   */
  startConnectorIndex(target: CrawlTarget): Promise<void>;
  /**
   * Fan out the order-independent text-extract drain. Optional: when absent the caller
   * relies on the inline drain inside {@link startConnectorIndex} (today's behavior),
   * so a host can wire only the crawl leg. On Cloudflare this enqueues onto the extract
   * Queue (ids only, never bytes); on Node it drains inline.
   */
  enqueueExtract?(jobs: ExtractJob[]): Promise<void>;
}

/** One unit of text-extract work — small + serializable (a Queue message: ids, never bytes). */
export interface ExtractJob {
  spaceId: string;
  ownerSub: string;
  pluginId: string;
  fileId: string;
}
