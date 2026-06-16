import * as XLSX from "xlsx";
import type { DocTables, Table } from "./types";

export function isSpreadsheet(name: string, mime?: string | null): boolean {
  return (
    /(spreadsheetml|ms-excel|excel|text\/csv|application\/csv|opendocument\.spreadsheet)/i.test(mime ?? "") ||
    /\.(xlsx|xlsm|xlsb|xls|csv|tsv|ods)$/i.test(name)
  );
}

/**
 * Extract a spreadsheet's sheets as tables of string cells via SheetJS. This is
 * an *exact* parse (`confidence: "high"`) — we surface `rowCount`/`colCount` per
 * sheet so a caller can sanity-check coverage rather than trust a flattened blob.
 * Handles `.xlsx/.xls/.csv/.ods/...`. Returns null for non-spreadsheets; never
 * throws (a corrupt file yields null).
 */
export async function spreadsheetTables(bytes: Uint8Array, name: string, mime?: string | null): Promise<DocTables | null> {
  if (!isSpreadsheet(name, mime)) return null;
  try {
    const wb = XLSX.read(bytes, { type: "array" });
    const tables: Table[] = wb.SheetNames.map((sheet) => {
      const ws = wb.Sheets[sheet];
      const raw = ws ? (XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: "" }) as unknown[][]) : [];
      const rows = raw.map((r) => r.map((cell) => (cell == null ? "" : String(cell))));
      const colCount = rows.reduce((max, r) => Math.max(max, r.length), 0);
      return { section: sheet, rows, rowCount: rows.length, colCount, confidence: "high" as const };
    });
    return { tables, meta: { sectionCount: tables.length } };
  } catch (err) {
    console.warn(`[docworker] spreadsheet parse failed for "${name}": ${(err as Error).message}`);
    return null;
  }
}
