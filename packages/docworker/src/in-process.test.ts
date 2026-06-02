import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { inProcessDocWorker } from "./in-process";
import { windowText } from "./window";
import { drainToBytes } from "./drain";
import { isPdf } from "./pdf";
import { isSpreadsheet } from "./spreadsheet";

// ── Windowing math (the paging contract) ───────────────────────────────────────

describe("windowText", () => {
  const full = "abcdefghij"; // length 10

  it("returns the whole string and reports total when no window is given", () => {
    expect(windowText(full)).toEqual({ text: "abcdefghij", total: 10, truncated: false });
  });

  it("slices [offset, offset+limit) and flags more to read", () => {
    expect(windowText(full, { offset: 2, limit: 3 })).toEqual({ text: "cde", total: 10, truncated: true });
  });

  it("is not truncated when the window reaches the end", () => {
    expect(windowText(full, { offset: 7, limit: 5 })).toEqual({ text: "hij", total: 10, truncated: false });
  });

  it("clamps an offset past the end to empty, not negative", () => {
    expect(windowText(full, { offset: 99, limit: 5 })).toEqual({ text: "", total: 10, truncated: false });
  });

  it("clamps a negative offset to 0", () => {
    expect(windowText(full, { offset: -5, limit: 4 })).toEqual({ text: "abcd", total: 10, truncated: true });
  });
});

// ── Bounded draining ───────────────────────────────────────────────────────────

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

describe("drainToBytes", () => {
  it("concatenates chunks under the cap", async () => {
    const r = await drainToBytes(streamOf(new Uint8Array([1, 2]), new Uint8Array([3])), 10);
    expect(r.truncated).toBe(false);
    expect(Array.from(r.bytes!)).toEqual([1, 2, 3]);
  });

  it("returns null + truncated when the stream exceeds the cap", async () => {
    const r = await drainToBytes(streamOf(new Uint8Array([1, 2, 3, 4])), 3);
    expect(r).toEqual({ bytes: null, truncated: true });
  });
});

// ── Format predicates ──────────────────────────────────────────────────────────

describe("format predicates", () => {
  it("detects PDFs by mime or extension", () => {
    expect(isPdf("a.pdf")).toBe(true);
    expect(isPdf("a", "application/pdf")).toBe(true);
    expect(isPdf("a.txt", "text/plain")).toBe(false);
  });

  it("detects spreadsheets by mime or extension", () => {
    expect(isSpreadsheet("budget.xlsx")).toBe(true);
    expect(isSpreadsheet("data.csv")).toBe(true);
    expect(isSpreadsheet("x", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe(true);
    expect(isSpreadsheet("notes.md", "text/markdown")).toBe(false);
  });
});

// ── Spreadsheet tables (real SheetJS round-trip) ───────────────────────────────

describe("inProcessDocWorker.extractTables", () => {
  const worker = inProcessDocWorker();

  it("parses an .xlsx workbook into per-sheet tables with exact counts", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["code", "qty", "total"], ["A1", 2, 50], ["A2", 1, 25]]), "Budget");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["x"], ["y"]]), "Notes");
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);

    const out = await worker.extractTables(bytes, "budget.xlsx");
    expect(out).not.toBeNull();
    expect(out!.meta.sectionCount).toBe(2);
    const budget = out!.tables[0]!;
    expect(budget.section).toBe("Budget");
    expect(budget.confidence).toBe("high");
    expect(budget.rowCount).toBe(3);
    expect(budget.colCount).toBe(3);
    expect(budget.rows[1]).toEqual(["A1", "2", "50"]); // cells stringified
  });

  it("parses a .csv into a single table", async () => {
    const bytes = new TextEncoder().encode("name,age\nAda,36\nGrace,40\n");
    const out = await worker.extractTables(bytes, "people.csv", "text/csv");
    expect(out!.tables).toHaveLength(1);
    expect(out!.tables[0]!.rows).toEqual([
      ["name", "age"],
      ["Ada", "36"],
      ["Grace", "40"],
    ]);
  });

  it("returns null for a non-spreadsheet", async () => {
    expect(await worker.extractTables(new Uint8Array([1, 2, 3]), "a.pdf", "application/pdf")).toBeNull();
  });
});
