import { beforeEach, describe, expect, it } from "vitest";
import { createLibsqlDb } from "./db-libsql";
import { MIGRATIONS, runMigrations } from "./schema";
import { ensureConnection, failIndexRun, finishIndexRun, startIndexRun } from "./connections";
import { failRun, finishRun, latestRun, listRuns, startRun } from "./runs";
import type { Db } from "./db";

let db: Db;
const key = { pluginId: "synology", jobName: "connector-index", instanceKey: "connector:synology:maya" };

beforeEach(async () => {
  db = createLibsqlDb(":memory:");
  await runMigrations(db);
});

describe("runs", () => {
  it("hands the cursor from the last done run to the next start", async () => {
    const first = await startRun(db, key);
    expect(first.cursor).toBeNull();
    await finishRun(db, first.id, { cursor: "1700000000" });

    const second = await startRun(db, key);
    expect(second.cursor).toBe("1700000000");
    expect(second.id).not.toBe(first.id);
  });

  it("does not return a failed run's cursor (next run retries the same range)", async () => {
    const first = await startRun(db, key);
    await finishRun(db, first.id, { cursor: "100" });
    const second = await startRun(db, key);
    await failRun(db, second.id, "boom");

    // The failed run's row keeps the seeded cursor, but the *handed* cursor is
    // still the last successful one.
    const third = await startRun(db, key);
    expect(third.cursor).toBe("100");
    const last = await latestRun(db, key);
    expect(last?.id).toBe(third.id);
    expect(last?.status).toBe("running");
  });

  it("round-trips stats as JSON and truncates long errors", async () => {
    const run = await startRun(db, key);
    await finishRun(db, run.id, { cursor: null, stats: { filesSeen: 42, folders: ["a", "b"] } });
    const done = await latestRun(db, key);
    expect(done?.stats).toEqual({ filesSeen: 42, folders: ["a", "b"] });

    const failed = await startRun(db, key);
    await failRun(db, failed.id, "x".repeat(600));
    const err = await latestRun(db, key);
    expect(err?.error).toHaveLength(500);
    expect(err?.finishedAt).not.toBeNull();
  });

  it("allows two concurrent runs for one key — coalescing is the dispatcher's job, not the table's", async () => {
    const [a, b] = await Promise.all([startRun(db, key), startRun(db, key)]);
    expect(a.id).not.toBe(b.id);
    const rows = await listRuns(db, { ...key, status: "running" });
    expect(rows).toHaveLength(2);
  });

  it("keys cursors independently per (pluginId, jobName, instanceKey)", async () => {
    const other = { ...key, instanceKey: "connector:synology:daniel" };
    const run = await startRun(db, key);
    await finishRun(db, run.id, { cursor: "555" });

    expect((await startRun(db, other)).cursor).toBeNull();
    expect((await startRun(db, { ...key, jobName: "connector-sweep" })).cursor).toBeNull();
    expect((await startRun(db, key)).cursor).toBe("555");
  });

  it("lists newest-first with filters and a limit", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await startRun(db, key);
      await finishRun(db, r.id, { cursor: String(i) });
    }
    const all = await listRuns(db, { pluginId: "synology" });
    expect(all).toHaveLength(3);
    expect(all[0]!.cursor).toBe("2"); // newest first
    expect(await listRuns(db, { pluginId: "synology", limit: 1 })).toHaveLength(1);
    expect(await listRuns(db, { pluginId: "github" })).toHaveLength(0);
  });
});

describe("index-run wrappers (compatibility until T6)", () => {
  it("keeps startIndexRun/finishIndexRun semantics — cursor handoff + filesSeen in stats", async () => {
    await ensureConnection(db, {
      id: "connector:synology:maya",
      tenantId: "connector:synology:maya",
      ownerId: "maya",
      type: "synology",
      name: "NAS",
    });
    const run = await startIndexRun(db, "connector:synology:maya");
    expect(run.cursor).toBeNull();
    await finishIndexRun(db, run.id, { cursor: "1700000123", filesSeen: 7 });

    const next = await startIndexRun(db, "connector:synology:maya");
    expect(next.cursor).toBe("1700000123");
    // The wrapper keys the run by the connection's type, so runs.ts consumers see it.
    const row = await latestRun(db, key);
    expect(row?.status).toBe("running");
    const done = await listRuns(db, { ...key, status: "done" });
    expect(done[0]!.stats).toEqual({ filesSeen: 7 });
  });

  it("failIndexRun leaves the cursor un-advanced", async () => {
    await ensureConnection(db, {
      id: "connector:synology:maya",
      tenantId: "connector:synology:maya",
      ownerId: "maya",
      type: "synology",
      name: "NAS",
    });
    const run = await startIndexRun(db, "connector:synology:maya");
    await failIndexRun(db, run.id, "list failed (401)");
    const next = await startIndexRun(db, "connector:synology:maya");
    expect(next.cursor).toBeNull();
  });
});

describe("migration 24 (index_runs → runs)", () => {
  /** Apply migrations up to (not including) `version`, mirroring runMigrations. */
  async function migrateBelow(target: number, d: Db): Promise<void> {
    await d.run("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const now = new Date().toISOString();
    for (const m of MIGRATIONS.filter((m) => m.version < target)) {
      await d.batch([
        ...m.statements.map((sql) => ({ sql })),
        { sql: "INSERT INTO _migrations (version, applied_at) VALUES (?, ?)", params: [m.version, now] },
      ]);
    }
  }

  it("copies rows across so the crawl cursor survives (incremental, not full, after upgrade)", async () => {
    const old = createLibsqlDb(":memory:");
    await migrateBelow(24, old);
    await ensureConnection(old, {
      id: "connector:synology:maya",
      tenantId: "connector:synology:maya",
      ownerId: "maya",
      type: "synology",
      name: "NAS",
    });
    await old.run(
      `INSERT INTO index_runs (id, connection_id, status, cursor, files_seen, started_at, finished_at)
       VALUES ('r1', 'connector:synology:maya', 'done', '1699999999', 12, '2026-07-01T00:00:00Z', '2026-07-01T00:05:00Z')`,
    );
    // An orphaned run (its connection row is gone) must still copy, with plugin_id ''.
    // FK enforcement would block seeding the orphan directly, so lift it for the insert.
    await old.run("PRAGMA foreign_keys = OFF");
    await old.run(
      `INSERT INTO index_runs (id, connection_id, status, cursor, files_seen, started_at, finished_at)
       VALUES ('r2', 'connector:gone:x', 'done', '42', 1, '2026-07-01T00:00:00Z', '2026-07-01T00:01:00Z')`,
    );
    await old.run("PRAGMA foreign_keys = ON");

    await runMigrations(old); // applies 24: copy + drop

    // Cursor continuity through the wrapper — the next sweep starts incremental.
    const next = await startIndexRun(old, "connector:synology:maya");
    expect(next.cursor).toBe("1699999999");
    const copied = await listRuns(old, { pluginId: "synology", jobName: "connector-index", status: "done" });
    expect(copied).toHaveLength(1);
    expect(copied[0]!.stats).toEqual({ filesSeen: 12 });

    // Orphan resolves the same way the wrapper does for a missing connection ('').
    const orphan = await startIndexRun(old, "connector:gone:x");
    expect(orphan.cursor).toBe("42");

    // The old table is gone.
    await expect(old.first("SELECT 1 FROM index_runs LIMIT 1")).rejects.toThrow();
  });
});
