import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import type { PluginManifest, ServerPlugin } from "@canopy/core";
import { inProcessJobs, latestRun, runMigrations } from "@canopy/store";
import { createLibsqlDb } from "@canopy/store/node";
import { jobsOf } from "./plugins";

describe("jobsOf (the jobs role registry)", () => {
  const plugin = (id: string, names: string[]): ServerPlugin => ({
    id,
    jobs: names.map((name) => ({ name, handler: async () => {} })),
  });

  it("looks up handlers by pluginId:name and returns null for unknowns", () => {
    const handlers = jobsOf([plugin("sync", ["run-flow", "sweep-flows"]), plugin("other", ["run-flow"])]);
    expect(handlers("sync", "run-flow")).toBeTypeOf("function");
    expect(handlers("other", "run-flow")).toBeTypeOf("function");
    expect(handlers("sync", "nope")).toBeNull();
    expect(handlers("nope", "run-flow")).toBeNull();
  });

  it("fails fast at composition on a duplicate pluginId:name", () => {
    const dup: ServerPlugin = {
      id: "sync",
      jobs: [
        { name: "run-flow", handler: async () => {} },
        { name: "run-flow", handler: async () => {} },
      ],
    };
    expect(() => jobsOf([dup])).toThrow("duplicate job registration: sync:run-flow");
  });

  it("a jobs-role ServerPlugin is dispatchable by name through the in-process adapter", async () => {
    const db = createLibsqlDb(":memory:");
    await runMigrations(db);
    let ran = 0;
    const registry = jobsOf([
      {
        id: "sync",
        jobs: [
          {
            name: "run-flow",
            schedule: "0 2 * * *",
            handler: async (ctx) => {
              ran++;
              await ctx.step("one", async () => {});
              ctx.setCursor("hw-1");
            },
          },
        ],
      },
    ]);
    const jobs = inProcessJobs({ db, handlers: registry });
    await jobs.start({ pluginId: "sync", name: "run-flow", instanceKey: "flow-1", payload: { flowId: "flow-1" } });
    expect(ran).toBe(1);
    const run = await latestRun(db, { pluginId: "sync", jobName: "run-flow", instanceKey: "flow-1" });
    expect(run?.status).toBe("done");
    expect(run?.cursor).toBe("hw-1");
  });
});

describe("manifest schema: the jobs grant", () => {
  const schema = JSON.parse(
    readFileSync(join(__dirname, "../../../documentation/canopy-plugin.schema.json"), "utf8"),
  ) as object;
  const ajv = new Ajv();
  const validate = ajv.compile(schema);
  const base = { id: "sync", name: "Sync", version: "0.1.0" };

  it("a manifest with the jobs capability and a jobs array validates", () => {
    const manifest: PluginManifest = {
      ...base,
      capabilities: [{ kind: "jobs" }, { kind: "net:fetch", hosts: ["thirdparty.example" ] }],
      jobs: [{ name: "run-flow", schedule: "0 2 * * *" }, { name: "sweep-flows" }],
    };
    expect(validate(manifest)).toBe(true);
  });

  it("a jobs array WITHOUT the jobs capability fails validation", () => {
    const manifest: PluginManifest = {
      ...base,
      capabilities: [{ kind: "kv" }],
      jobs: [{ name: "run-flow" }],
    };
    expect(validate(manifest)).toBe(false);
  });

  it("Capability union and schema stay mirror-identical (every kind round-trips)", () => {
    // One minimal manifest per Capability variant — a schema/type drift breaks this.
    const kinds: PluginManifest["capabilities"] = [
      { kind: "item:read" },
      { kind: "item:write" },
      { kind: "index:query" },
      { kind: "storage:read", connectors: ["documentation"] },
      { kind: "net:fetch", hosts: ["api.github.com"] },
      { kind: "kv" },
      { kind: "ai:generate", models: ["gemini"] },
      { kind: "jobs" },
    ];
    for (const cap of kinds) {
      const ok = validate({ ...base, capabilities: [cap], ...(cap.kind === "jobs" ? { jobs: [{ name: "j" }] } : {}) });
      expect(ok, `capability ${cap.kind} should validate: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });
});
