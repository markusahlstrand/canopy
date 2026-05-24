import { describe, expect, it, beforeEach } from "vitest";
import { createLibsqlDb } from "./db-libsql";
import { createSqlBlobRepo } from "./repo";
import { runMigrations } from "./schema";
import { FileService } from "./files";
import type { Db } from "./db";
import type { BlobStore } from "./blob-store";

/** A throwaway blob store — custom plugins don't touch it, but FileService needs one. */
const nullStore: BlobStore = {
  async has() {
    return false;
  },
  async put() {},
  async get() {
    return null;
  },
  async delete() {},
};

const USER = "user-1";
const manifest = (id: string) =>
  JSON.stringify({ id, name: "GPX Viewer", version: "0.1.0", capabilities: [{ kind: "item:read" }] });

let db: Db;
let svc: FileService;

beforeEach(async () => {
  db = createLibsqlDb(":memory:");
  await runMigrations(db);
  svc = new FileService(db, nullStore, createSqlBlobRepo(db));
});

describe("custom (AI-generated) plugins", () => {
  it("saves a plugin and adds it to the installed set", async () => {
    await svc.addCustomPlugin(USER, { id: "gpx-viewer", manifest: manifest("gpx-viewer"), source: "export default () => {}" });

    const list = await svc.listCustomPlugins(USER);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("gpx-viewer");
    expect(list[0]!.source).toContain("export default");
    expect(JSON.parse(list[0]!.manifest).name).toBe("GPX Viewer");

    // The id is now in the user's installed set, so it goes active.
    expect(await svc.getInstalledPlugins(USER)).toContain("gpx-viewer");
  });

  it("upserts in place (no duplicate row, created_at preserved)", async () => {
    await svc.addCustomPlugin(USER, { id: "gpx-viewer", manifest: manifest("gpx-viewer"), source: "v1" });
    const first = (await svc.getCustomPlugin(USER, "gpx-viewer"))!;
    await svc.addCustomPlugin(USER, { id: "gpx-viewer", manifest: manifest("gpx-viewer"), source: "v2" });

    const list = await svc.listCustomPlugins(USER);
    expect(list).toHaveLength(1);
    const second = (await svc.getCustomPlugin(USER, "gpx-viewer"))!;
    expect(second.source).toBe("v2");
    expect(second.createdAt).toBe(first.createdAt);
  });

  it("removes a plugin and drops it from the installed set", async () => {
    await svc.addCustomPlugin(USER, { id: "gpx-viewer", manifest: manifest("gpx-viewer"), source: "x" });
    await svc.removeCustomPlugin(USER, "gpx-viewer");

    expect(await svc.listCustomPlugins(USER)).toHaveLength(0);
    expect(await svc.getInstalledPlugins(USER) ?? []).not.toContain("gpx-viewer");
  });

  it("scopes plugins to their owner", async () => {
    await svc.addCustomPlugin(USER, { id: "gpx-viewer", manifest: manifest("gpx-viewer"), source: "x" });
    expect(await svc.listCustomPlugins("user-2")).toHaveLength(0);
  });
});
