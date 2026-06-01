import { extractText, getDocumentProxy } from "unpdf";
import type { PDFDocumentProxy } from "unpdf/pdfjs";
import type { DocOutline, OutlineEntry, RangedText, TextWindow } from "./types";
import { windowText } from "./window";

/** Stop walking a PDF's bookmark tree past this many nodes (pathological TOCs). */
const MAX_OUTLINE_NODES = 1000;

export function isPdf(name: string, mime?: string | null): boolean {
  return /^application\/(x-)?pdf$/i.test(mime ?? "") || /\.pdf$/i.test(name);
}

/** Parse bytes into a pdf.js document proxy, or null if not a parseable PDF. Never throws. */
async function loadPdf(bytes: Uint8Array, name: string, mime?: string | null): Promise<PDFDocumentProxy | null> {
  if (!isPdf(name, mime)) return null;
  if (!bytes || bytes.byteLength === 0) return null;
  try {
    return await getDocumentProxy(bytes);
  } catch (err) {
    console.warn(`[docworker] pdf parse failed for "${name}": ${(err as Error).message}`);
    return null;
  }
}

/**
 * Extract a window of a PDF's embedded text layer. Reads the *text layer*, not
 * OCR: digitally-generated PDFs carry selectable text and extract cleanly;
 * scanned/image-only PDFs have no text layer and yield null. `total` is the full
 * length so the caller can page and report `has_more`; the slice is
 * `[offset, offset+limit)`, defaulting to the whole document when `limit` is
 * omitted. Uses `unpdf` (a serverless pdf.js build) — unchanged on Node and
 * the Workers isolate.
 */
export async function pdfText(
  bytes: Uint8Array,
  name: string,
  mime?: string | null,
  opts?: TextWindow,
): Promise<RangedText | null> {
  const pdf = await loadPdf(bytes, name, mime);
  if (!pdf) return null;
  try {
    const { text, totalPages } = await extractText(pdf, { mergePages: true });
    return { ...windowText(text.trim(), opts), pageCount: totalPages };
  } catch (err) {
    console.warn(`[docworker] pdf text extraction failed for "${name}": ${(err as Error).message}`);
    return null;
  }
}

/** Resolve a pdf.js outline `dest` to a 1-based page number, best-effort. */
async function resolveOutlinePage(pdf: PDFDocumentProxy, dest: string | unknown[] | null): Promise<number | null> {
  try {
    const explicit = Array.isArray(dest) ? dest : typeof dest === "string" ? await pdf.getDestination(dest) : null;
    const ref = explicit?.[0];
    if (ref && typeof ref === "object") {
      // getPageIndex wants a RefProxy; the dest's first element is exactly that.
      const idx = await pdf.getPageIndex(ref as Parameters<PDFDocumentProxy["getPageIndex"]>[0]);
      return idx + 1;
    }
  } catch {
    /* unresolvable destination — leave the page unknown */
  }
  return null;
}

type RawOutlineItem = { title: string; dest: string | unknown[] | null; items?: RawOutlineItem[] };

/**
 * Read a PDF's structure — page count, document title, and the embedded
 * bookmark tree (flattened, with page numbers resolved best-effort) — *without*
 * extracting the page text. Cheap relative to {@link pdfText}: it only walks the
 * outline dictionary. Returns null if the file isn't a parseable PDF.
 */
export async function pdfOutline(bytes: Uint8Array, name: string, mime?: string | null): Promise<DocOutline | null> {
  const pdf = await loadPdf(bytes, name, mime);
  if (!pdf) return null;
  try {
    let documentTitle: string | undefined;
    try {
      const { info } = await pdf.getMetadata();
      const title = (info as { Title?: unknown } | undefined)?.Title;
      if (typeof title === "string" && title.trim()) documentTitle = title.trim();
    } catch {
      /* metadata is optional */
    }

    const entries: OutlineEntry[] = [];
    const raw = (await pdf.getOutline().catch(() => null)) as RawOutlineItem[] | null;
    if (raw) {
      const walk = async (items: RawOutlineItem[], level: number): Promise<void> => {
        for (const item of items) {
          if (entries.length >= MAX_OUTLINE_NODES) return;
          entries.push({
            title: (item.title ?? "").trim(),
            level,
            page: await resolveOutlinePage(pdf, item.dest),
          });
          if (item.items?.length) await walk(item.items, level + 1);
        }
      };
      await walk(raw, 1);
    }

    return { pageCount: pdf.numPages, documentTitle, entries };
  } catch (err) {
    console.warn(`[docworker] pdf outline failed for "${name}": ${(err as Error).message}`);
    return null;
  }
}
