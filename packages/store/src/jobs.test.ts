import { beforeEach, describe, expect, it } from "vitest";
import { createLibsqlDb } from "./db-libsql";
import { runMigrations } from "./schema";
import { latestRun, listRuns } from "./runs";
import { assertJobPayload, type JobContext, type JobHandler } from "./jobs";
import { inProcessJobs, type LocalJobsDeps } from "./jobs-local";
import type { Db } from "./db";

let db: Db;
const registry = new Map<string, JobHandler>();
const handlers: LocalJobsDeps["handlers"] = (pluginId, name) => registry.get(`${pluginId}:${name}`) ?? null;
/** Instant sleep that records the delays the adapter asked for. */
let slept: number[];
const sleep = (ms: number) => {
  slept.push(ms);
  return Promise.resolve();
};
const jobs = () => inProcessJobs({ db, handlers, sleep });
const key = { pluginId: "sync", jobName: "run-flow", instanceKey: "flow-1" };
const req = { pluginId: "sync", name: "run-flow", instanceKey: "flow-1", payload: {} };

beforeEach(async () => {
  db = createLibsqlDb(":memory:");
  await runMigrations(db);
  registry.clear();
  slept = [];
});

describe("in-process Jobs adapter", () => {
  it("runs a three-step handler to completion; the runs row goes running → done with the handler's cursor", async () => {
    const order: string[] = [];
    registry.set("sync:run-flow", async (ctx) => {
      expect(ctx.cursor).toBeNull(); // first run — nothing to resume from
      await ctx.step("list-0", async () => order.push("list-0"));
      await ctx.step("ingest-a", async () => order.push("ingest-a"));
      await ctx.step("deliver-a", async () => order.push("deliver-a"));
      ctx.setCursor("2026-07-12T00:00:00Z");
    });
    await jobs().start(req);
    expect(order).toEqual(["list-0", "ingest-a", "deliver-a"]);
    const run = await latestRun(db, key);
    expect(run?.status).toBe("done");
    expect(run?.cursor).toBe("2026-07-12T00:00:00Z");
  });

  it("hands the cursor to the next run; a handler that never sets one carries it forward", async () => {
    const seen: (string | null)[] = [];
    registry.set("sync:run-flow", async (ctx) => {
      seen.push(ctx.cursor);
      if (ctx.cursor === null) ctx.setCursor("100"); // only the first run advances it
    });
    const j = jobs();
    await j.start(req);
    await j.start(req);
    await j.start(req);
    expect(seen).toEqual([null, "100", "100"]);
    expect((await latestRun(db, key))?.cursor).toBe("100"); // carried forward, not dropped
  });

  it("coalesces concurrent starts for one key; different instance keys run concurrently", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    registry.set("sync:run-flow", async () => {
      calls++;
      await gate;
    });
    const j = jobs();
    const a = j.start(req);
    const b = j.start(req); // in-flight same key → coalesced
    const c = j.start({ ...req, instanceKey: "flow-2" }); // different key → own run
    expect(b).toBe(a);
    release();
    await Promise.all([a, b, c]);
    expect(calls).toBe(2);
    expect(await listRuns(db, { pluginId: "sync", status: "done" })).toHaveLength(2);

    // The key frees up once settled: a later start runs again.
    await j.start(req);
    expect(calls).toBe(3);
  });

  it("retries a step with exponential backoff, then succeeds", async () => {
    let attempts = 0;
    registry.set("sync:run-flow", async (ctx) => {
      await ctx.step("flaky", async () => {
        attempts++;
        if (attempts < 3) throw new Error("transient");
      });
    });
    await jobs().start(req);
    expect(attempts).toBe(3);
    expect(slept).toEqual([5_000, 10_000]); // 5s, then doubled
    expect((await latestRun(db, key))?.status).toBe("done");
  });

  it("a permanently failing step exhausts retries, records error, and a re-start re-executes from step 1", async () => {
    const stepOneRuns: number[] = [];
    let healed = false;
    registry.set("sync:run-flow", async (ctx) => {
      await ctx.step("one", async () => stepOneRuns.push(1));
      await ctx.step(
        "two",
        async () => {
          if (!healed) throw new Error("backend down");
        },
        { retries: { limit: 2, delayMs: 10 } },
      );
      ctx.setCursor("done-cursor");
    });
    const j = jobs();
    await expect(j.start(req)).rejects.toThrow("backend down");
    let run = await latestRun(db, key);
    expect(run?.status).toBe("error");
    expect(run?.error).toBe("backend down");
    expect(run?.cursor).toBeNull(); // never advanced

    healed = true;
    await j.start(req); // steps are idempotent-by-contract — the re-run converges
    expect(stepOneRuns).toHaveLength(2); // step 1 re-executed (no replay cache in-process)
    run = await latestRun(db, key);
    expect(run?.status).toBe("done");
    expect(run?.cursor).toBe("done-cursor");
  });

  it("an unknown pluginId:name records an error run with a clear message and does not throw", async () => {
    await jobs().start({ ...req, name: "nope" });
    const run = await latestRun(db, { ...key, jobName: "nope" });
    expect(run?.status).toBe("error");
    expect(run?.error).toContain("sync:nope");
  });

  it("rejects payloads that would not survive a queue message (bytes, functions)", async () => {
    registry.set("sync:run-flow", async () => {});
    const j = jobs();
    expect(() => j.start({ ...req, payload: { bytes: new Uint8Array([1, 2]) } })).toThrow(/never bytes/);
    expect(() => j.start({ ...req, payload: { cb: () => {} } })).toThrow(/not JSON-serializable/);
    // Nothing was dispatched — no run rows for the key.
    expect(await listRuns(db, { pluginId: "sync" })).toHaveLength(0);
  });

  it("hands the handler a JSON round-trip of the payload, not the caller's object graph", async () => {
    let got: Record<string, unknown> | undefined;
    registry.set("sync:run-flow", async (ctx) => {
      got = ctx.payload;
    });
    const payload = { ids: ["a", "b"], nested: { n: 1 } };
    await jobs().start({ ...req, payload });
    expect(got).toEqual(payload);
    expect(got).not.toBe(payload); // queue-boundary simulation
    expect(got!.ids).not.toBe(payload.ids);
  });

  it("routes ctx.log to the RunLog sink keyed by logKey ?? instanceKey; a throwing sink never fails the run", async () => {
    const lines: [string, string, string | undefined][] = [];
    registry.set("sync:run-flow", async (ctx) => {
      await ctx.log("hello");
      await ctx.log("bad", "error");
    });
    const deps: LocalJobsDeps = {
      db,
      handlers,
      sleep,
      log: async (k, m, l) => {
        if (m === "bad") throw new Error("channel down");
        lines.push([k, m, l]);
      },
    };
    await inProcessJobs(deps).start({ ...req, logKey: "space-9" });
    expect(lines).toEqual([["space-9", "hello", undefined]]);
    await inProcessJobs(deps).start({ ...req, instanceKey: "flow-3" });
    expect(lines[1]![0]).toBe("flow-3"); // falls back to instanceKey
    expect((await latestRun(db, { ...key, instanceKey: "flow-3" }))?.status).toBe("done");
  });
});

describe("assertJobPayload", () => {
  it("accepts JSON scalars, plain objects, arrays, null", () => {
    expect(() => assertJobPayload({ a: 1, b: "x", c: [true, null, { d: 2 }] })).not.toThrow();
  });

  it("rejects bytes, class instances, bigints, undefined, non-finite numbers — with the offending path", () => {
    expect(() => assertJobPayload({ buf: new ArrayBuffer(4) })).toThrow(/payload\.buf.*never bytes/);
    expect(() => assertJobPayload({ when: new Date() })).toThrow(/payload\.when.*Date/);
    expect(() => assertJobPayload({ big: 1n })).toThrow(/payload\.big/);
    expect(() => assertJobPayload({ list: [undefined] })).toThrow(/payload\.list\[0\]/);
    expect(() => assertJobPayload({ n: Infinity })).toThrow(/payload\.n/);
  });
});
