/**
 * The document-parsing capability Canopy needs, behind one adapter interface.
 *
 * Two implementations satisfy it: {@link inProcessDocWorker} (pure JS — `unpdf`
 * for PDFs, SheetJS for spreadsheets; runs unchanged on Node and the Cloudflare
 * Workers isolate) and a container-backed client that forwards to a sidecar
 * service. The container is therefore *one backend*, never a hard dependency —
 * the same code runs locally on pure Node.
 *
 * Every method is bytes-in: PDFs and spreadsheets must be read whole to parse
 * (a PDF's cross-ref table lives at the end), and a uniform `Uint8Array` input
 * is what both the in-process parser and an HTTP request body want. Callers
 * drain the blob stream (bounded) before calling — see `drainToBytes`.
 *
 * Methods never throw: an unparseable or unsupported file yields `null`.
 */
export interface DocWorker {
  /** Whether a text layer can be extracted (PDF). Cheap name/mime check, no bytes. */
  supportsText(name: string, mime?: string | null): boolean;
  /** Whether tabular data can be extracted (spreadsheet). Cheap name/mime check. */
  supportsTables(name: string, mime?: string | null): boolean;

  /**
   * Extract a window of a document's plain text. `total` is the full character
   * count (so the caller can page and report `has_more`); the returned `text` is
   * `[offset, offset+limit)` of it. `truncated` means the window stops before
   * `total`. Returns null when the file isn't a supported document.
   */
  extractText(
    bytes: Uint8Array,
    name: string,
    mime?: string | null,
    opts?: TextWindow,
  ): Promise<RangedText | null>;

  /** Document structure (PDF bookmarks / TOC) without the body. Null if unsupported. */
  extractOutline(bytes: Uint8Array, name: string, mime?: string | null): Promise<DocOutline | null>;

  /** Tabular data (spreadsheet sheets → rows). Null if unsupported. */
  extractTables(bytes: Uint8Array, name: string, mime?: string | null): Promise<DocTables | null>;
}

/** Character window into a document's text. Omitted `limit` means "to the end". */
export interface TextWindow {
  offset?: number;
  limit?: number;
}

/** A windowed slice of a document's text, plus the full length for paging. */
export interface RangedText {
  /** The slice `[offset, offset+limit)` of the full extracted text. */
  text: string;
  /** Full extracted length in characters (pre-windowing). */
  total: number;
  /** True when the window ends before `total` — there is more to read. */
  truncated: boolean;
  /** Page count, for paginated formats (PDF). */
  pageCount?: number;
}

/** One entry in a document's outline (a PDF bookmark / TOC item). */
export interface OutlineEntry {
  /** Bookmark label. */
  title: string;
  /** Nesting depth, 1 for top-level. */
  level: number;
  /** 1-based page the bookmark points at, or null if it couldn't be resolved. */
  page: number | null;
}

/** A document's structure without its content. */
export interface DocOutline {
  /** Page count, when known. */
  pageCount?: number;
  /** Document title from the file's metadata, if present. */
  documentTitle?: string;
  /** Embedded bookmarks/TOC, flattened depth-first with a `level` per entry. */
  entries: OutlineEntry[];
}

/**
 * One detected table. For spreadsheets this is a sheet (exact, `confidence:
 * "high"`); a future PDF-table extractor would emit best-effort tables with
 * `confidence: "low"` and a `coverage` hint so callers can sanity-check.
 */
export interface Table {
  /** Sheet name (spreadsheets) or a page label (future PDF tables). */
  section: string;
  /** Cells as strings, row-major. */
  rows: string[][];
  rowCount: number;
  colCount: number;
  /** How much to trust the parse. Spreadsheets are exact; heuristic parsers are "low". */
  confidence: "high" | "low";
  /** Best-effort parsers: fraction of the source captured (0..1). Omitted when exact. */
  coverage?: number;
}

/** Structured tables extracted from a document. */
export interface DocTables {
  tables: Table[];
  meta: { sectionCount: number };
}
