import { describe, expect, it, beforeEach } from "vitest";
import { createLibsqlDb } from "./db-libsql";
import { runMigrations } from "./schema";
import { listMcpClients, recordMcpClient } from "./mcp-clients";
import type { Db } from "./db";

/**
 * The MCP-clients trace against a real libsql engine, so the UPSERT (ON CONFLICT
 * + COALESCE) behaves exactly as in D1. Covers: first contact records the
 * handshake name; a later nameless call keeps it and bumps last_seen; distinct
 * clients and distinct users stay separate.
 */

const USER = "user-1";
let db: Db;

beforeEach(async () => {
  db = createLibsqlDb(":memory:");
  await runMigrations(db);
});

describe("mcp clients", () => {
  it("records the handshake name then keeps it on later nameless calls", async () => {
    await recordMcpClient(db, USER, "claude", { name: "Claude", version: "1.2.3" });
    const first = (await listMcpClients(db, USER))[0]!;
    expect(first.name).toBe("Claude");
    expect(first.version).toBe("1.2.3");

    // A subsequent tool call carries no clientInfo — name/version must survive.
    await recordMcpClient(db, USER, "claude");
    const again = (await listMcpClients(db, USER))[0]!;
    expect(again.name).toBe("Claude");
    expect(again.version).toBe("1.2.3");
    expect(again.firstSeenAt).toBe(first.firstSeenAt); // first_seen is sticky
    expect(again.lastSeenAt >= first.firstSeenAt).toBe(true); // last_seen advances (or ties)
  });

  it("keeps distinct clients and users separate", async () => {
    await recordMcpClient(db, USER, "chatgpt", { name: "ChatGPT" });
    await recordMcpClient(db, USER, "claude", { name: "Claude" });
    await recordMcpClient(db, "user-2", "claude", { name: "Claude" });

    const mine = await listMcpClients(db, USER);
    expect(mine.map((c) => c.clientId).sort()).toEqual(["chatgpt", "claude"]);
    expect(await listMcpClients(db, "user-2")).toHaveLength(1);
  });

  it("orders by most recently active first", async () => {
    const tick = () => new Promise((r) => setTimeout(r, 10)); // distinct last_seen ms
    await recordMcpClient(db, USER, "chatgpt", { name: "ChatGPT" });
    await tick();
    await recordMcpClient(db, USER, "claude", { name: "Claude" });
    await tick();
    await recordMcpClient(db, USER, "chatgpt"); // chatgpt is now the newest touch

    expect((await listMcpClients(db, USER)).map((c) => c.clientId)).toEqual(["chatgpt", "claude"]);
  });

  it("returns nothing for a user who never connected", async () => {
    expect(await listMcpClients(db, "nobody")).toEqual([]);
  });
});
