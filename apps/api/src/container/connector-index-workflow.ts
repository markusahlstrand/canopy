// Durable connector-index Workflow (Cloudflare-only).
//
// ISOLATION: like docworker-do.ts / space-channel.ts, this is reached only through
// worker-cf.ts and is EXCLUDED from apps/api's main `tsc` typecheck — it imports the
// Cloudflare runtime module `cloudflare:workers`, which the main program never touches.
// Wrangler/esbuild transpiles it at deploy; the bundle is validated by `wrangler deploy
// --dry-run`. Node never imports this.
//
// WHY a Workflow: a full crawl of a large NAS/repo blows a single Worker's subrequest +
// CPU budget (the reason the old inline `crawlConnector` in waitUntil died mid-tree).
// Each `step.do()` is its own invocation with a fresh budget and the engine resumes from
// the last committed step on crash — so we crawl one folder per step (BFS frontier lives
// in replayed step state) and drain text extraction in bounded batches per step. The same
// FileService primitives (`reconcileConnectorFolder`, `drainExternalExtractQueue`) the
// in-process runner uses — only the chunking driver differs. D1 stays source of truth;
// rows bump the change sequence and the offline mirror picks them up via the delta.
import { WorkflowEntrypoint } from "cloudflare:workers";
import { failIndexRun, finishIndexRun, startIndexRun, type CrawlTarget } from "@canopy/store";
import { buildDeps } from "../worker";

/** Files whose bytes we read + extract per step — bounded so one step stays in budget. */
const EXTRACT_BATCH = 5;
/** Safety cap on extraction steps so a wedged extractor can't loop forever (~25k files). */
const MAX_EXTRACT_STEPS = 5000;

/** "1 file" / "3 files" — keep progress lines readable. */
const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

export class ConnectorIndexWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const target = event.payload as CrawlTarget;
    const { db, service, connectorForUser, indexLog } = await buildDeps(this.env);
    const connector = await connectorForUser(target.ownerSub, target.pluginId);
    if (!connector) return;

    // Progress lines are streamed to the space's live channel for the settings dialog
    // (live-only, never persisted). They're emitted INSIDE a `step.do` so a line fires
    // when its step actually runs — cached steps on a crash-resume don't re-post them.
    const log = (message: string, level?: "info" | "error") => indexLog(target.spaceId, message, level);

    const run = await step.do("start-run", async () => {
      const r = await startIndexRun(db, target.spaceId);
      await log("Indexing started");
      return r;
    });
    try {
      // Breadth-first crawl, one folder per step. The frontier + `seen` (+ `totalFiles`)
      // rebuild deterministically on resume because completed steps replay their cached
      // results, so step names (`reconcile-<n>`) stay stable.
      const frontier: string[] = [""];
      const seen = new Set<string>();
      let page = 0;
      let totalFiles = 0;
      while (frontier.length) {
        const dir = frontier.shift()!;
        if (seen.has(dir)) continue;
        seen.add(dir);
        const result = await step.do(
          `reconcile-${page++}`,
          { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
          async () => {
            const { folders, files } = await service.reconcileConnectorFolder(
              target.ownerSub,
              target.spaceId,
              target.pluginId,
              connector,
              dir,
            );
            await log(`Scanned ${dir || "/"} — ${plural(files, "file")}, ${plural(folders.length, "subfolder")}`);
            return { folders, files };
          },
        );
        totalFiles += result.files;
        for (const sub of result.folders) if (!seen.has(sub)) frontier.push(sub);
      }

      // Drain text extraction off the crawl's budget, a small batch per step, until
      // nothing is pending. Each extract reads bytes through the connector + parses, so
      // the batch stays small; `drainExternalExtractQueue` is idempotent (gated on
      // extract_state), so a retried step is safe.
      for (let i = 0; i < MAX_EXTRACT_STEPS; i++) {
        const drained: boolean = await step.do(
          `extract-${i}`,
          { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
          async () => {
            const { extracted, failed } = await service.drainExternalExtractQueue(EXTRACT_BATCH);
            if (extracted + failed > 0) {
              await log(`Extracted ${plural(extracted, "file")}${failed ? `, ${failed} failed` : ""}`);
            }
            return extracted + failed === 0; // true → nothing left pending
          },
        );
        if (drained) break;
      }

      await step.do("finish-run", async () => {
        await finishIndexRun(db, run.id, { cursor: String(Math.floor(Date.now() / 1000)), filesSeen: seen.size });
        await log(`Done — ${plural(seen.size, "folder")}, ${plural(totalFiles, "file")}`);
      });
    } catch (err) {
      await step.do("fail-run", async () => {
        await failIndexRun(db, run.id, (err as Error).message);
        await log(`Error: ${(err as Error).message}`, "error");
      });
      throw err;
    }
  }
}
