import { describe, expect, it } from "vitest";
import { createDocWorkerApp } from "./app";

describe("docworker service", () => {
  it("serves /health without a token", async () => {
    const app = createDocWorkerApp({ token: "secret" });
    const res = await app.fetch(new Request("http://x/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects a protected route without the shared secret", async () => {
    const app = createDocWorkerApp({ token: "secret" });
    const res = await app.fetch(new Request("http://x/extract/tables", { method: "POST", body: "a,b\n1,2\n" }));
    expect(res.status).toBe(401);
  });

  it("extracts tabular data from an inline CSV body", async () => {
    const app = createDocWorkerApp({ token: "secret" });
    const res = await app.fetch(
      new Request("http://x/extract/tables", {
        method: "POST",
        headers: { "x-docworker-token": "secret", "x-doc-name": "data.csv", "x-doc-mime": "text/csv" },
        body: "a,b\n1,2\n",
      }),
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as { tables: { rows: string[][] }[]; meta: { sectionCount: number } };
    expect(out.meta.sectionCount).toBe(1);
    expect(out.tables[0]!.rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("returns null for a non-document inline body", async () => {
    const app = createDocWorkerApp(); // no token required
    const res = await app.fetch(
      new Request("http://x/extract/tables", {
        method: "POST",
        headers: { "x-doc-name": "note.txt", "x-doc-mime": "text/plain" },
        body: "just some prose, not a table",
      }),
    );
    expect(await res.json()).toBeNull();
  });
});
