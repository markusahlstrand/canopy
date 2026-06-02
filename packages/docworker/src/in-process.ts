import { isPdf, pdfOutline, pdfText } from "./pdf";
import { isSpreadsheet, spreadsheetTables } from "./spreadsheet";
import type { DocWorker } from "./types";

/**
 * The default {@link DocWorker}: parses in-process with pure-JS libraries
 * (`unpdf` + SheetJS), so it runs unchanged on Node and the Cloudflare Workers
 * isolate with no external service. This is what keeps Canopy fully functional
 * on pure Node — the container backend is an optional drop-in for offloading
 * heavy parsing or reaching a tailnet-only source, never a requirement.
 */
export function inProcessDocWorker(): DocWorker {
  return {
    supportsText: isPdf,
    supportsTables: isSpreadsheet,
    extractText: (bytes, name, mime, opts) => pdfText(bytes, name, mime, opts),
    extractOutline: (bytes, name, mime) => pdfOutline(bytes, name, mime),
    extractTables: (bytes, name, mime) => spreadsheetTables(bytes, name, mime),
  };
}
