import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  BlobHashMismatchError,
  BlobMissingError,
  NotFoundError,
  PermissionError,
  sha256hex,
  type Caller,
} from "@canopy/store";
import type { DriveDeps } from "./index";
import { drainToBytes } from "@canopy/docworker";

/**
 * Max bytes we read from a blob to build its readable text. A file larger than
 * this can only be read as a prefix, which `fetch`/`get_outline` flag with
 * `truncated` so the reported `total` is understood as a lower bound.
 */
const MAX_READ_BYTES = 20 * 1024 * 1024;

/**
 * Default and hard cap on the characters `fetch` returns in a single call. A
 * file longer than this comes back with `has_more: true`, so paging is explicit
 * and a truncated read is never silent.
 */
const MAX_WINDOW_CHARS = 512 * 1024;

/** Cap on headings returned for a text document (guards a pathological file). */
const MAX_TEXT_HEADINGS = 1000;

/** Default cap on rows returned per table — the true `row_count` is always reported. */
const DEFAULT_MAX_TABLE_ROWS = 1000;

/**
 * Whether a file's bytes are worth returning as text. A trimmed copy of the
 * store's private `isTextLike` (kept here so the store package stays untouched).
 */
function isTextLike(name: string, mime?: string | null): boolean {
  if (mime && (mime.startsWith("text/") || /(json|xml|yaml|markdown|javascript|typescript|csv|html|svg)/i.test(mime))) {
    return true;
  }
  return /\.(md|markdown|txt|text|csv|tsv|json|ya?ml|toml|ini|cfg|log|html?|xml|svg|js|jsx|ts|tsx|css|scss|less|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|sh|bash|sql|php)$/i.test(name);
}

/**
 * Read a blob's bytes (up to `cap`) and decode as UTF-8 (lossy). `truncated` is
 * true when the stream held more bytes than `cap` — i.e. we only saw a prefix,
 * so any total derived from this text is a floor, not the real length.
 */
async function readReadableText(
  stream: ReadableStream<Uint8Array>,
  cap: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total >= cap) {
        // Peek one more read to tell "exactly cap" from "there's more".
        const extra = await reader.read();
        truncated = !extra.done;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) {
    buf.set(ch, off);
    off += ch.byteLength;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(buf), truncated };
}

/**
 * Pull a heading outline out of plain text. For Markdown we read ATX headings
 * (`#`..`######`), skipping fenced code blocks; other text types have no
 * headings, so we just report the line count.
 */
function textOutline(
  text: string,
  name: string,
  mime?: string | null,
): { headings: { level: number; title: string; line: number }[]; lines: number } {
  const lines = text.split("\n");
  const isMarkdown = /markdown/i.test(mime ?? "") || /\.(md|markdown|mdown|mkd)$/i.test(name);
  const headings: { level: number; title: string; line: number }[] = [];
  if (isMarkdown) {
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
      if (m && m[1] && m[2]) {
        headings.push({ level: m[1].length, title: m[2].trim(), line: i + 1 });
        if (headings.length >= MAX_TEXT_HEADINGS) break;
      }
    }
  }
  return { headings, lines: lines.length };
}

function decodeContent(content: string, encoding: "utf8" | "base64"): Uint8Array {
  if (encoding === "base64") return Uint8Array.from(atob(content), (ch) => ch.charCodeAt(0));
  return new TextEncoder().encode(content);
}

/** Map a drive domain error to a short, model-readable message. */
function describeError(err: unknown): string {
  if (err instanceof PermissionError) return "forbidden: you don't have access to this item";
  if (err instanceof NotFoundError) return "not found";
  if (err instanceof BlobMissingError) return "the file content has not been uploaded";
  if (err instanceof BlobHashMismatchError) return (err as Error).message;
  return (err as Error).message || "unexpected error";
}

const ok = (data: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const fail = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });
const guard = async (fn: () => Promise<CallToolResult>): Promise<CallToolResult> => {
  try {
    return await fn();
  } catch (err) {
    return fail(describeError(err));
  }
};

/**
 * Register Canopy's MCP tools on a server instance. `search`/`fetch` follow the
 * ChatGPT connector contract; the rest are Canopy-native read/write tools. Every
 * call runs as `ctx.caller`, so the drive's per-space ACL is the security boundary
 * — a token for one user can never reach another user's files.
 */
export function registerTools(server: McpServer, ctx: { caller: Caller; drive: DriveDeps; origin: string }): void {
  const { caller, drive, origin } = ctx;
  const service = drive.service;
  const docWorker = drive.docWorker;
  const spaceFor = async (space?: string) => space ?? (await service.personalSpace(caller.sub));
  const fileUrl = (id: string) => `${origin}/api/files/${id}/content`;

  server.registerTool(
    "search",
    {
      title: "Search files",
      description:
        "Full-text search across the files you can access. Returns matches with an `id` and `url` for each; pass an `id` to `fetch` to read the file.",
      inputSchema: { query: z.string().describe("Free-text search query") },
    },
    ({ query }) =>
      guard(async () => {
        const text = query.trim();
        if (!text) return ok({ results: [] });
        const { items } = await service.search(caller.sub, { text, limit: 20 });
        return ok({
          results: items.map((h) => ({ id: h.id, title: h.title, url: fileUrl(h.id), snippet: h.snippet })),
        });
      }),
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch a file",
      description:
        "Fetch a file's text content and metadata by id (ids come from `search` or `list_folder`). " +
        "PDFs return their extracted text layer; other binary files return metadata and a download `url` with empty text. " +
        "Use `offset`/`limit` (in characters) to read a window of a large file. The response always reports `total` " +
        "(the full character count of the readable text), the applied `offset`/`limit`, and `has_more` — so a partial read " +
        "is never silent: page forward by passing `offset = previous offset + limit` while `has_more` is true. " +
        "`truncated: true` means the file was too large to read in full, so `total` is a lower bound. PDFs also report " +
        "`page_count`; call `get_outline` first to decide which range to fetch.",
      inputSchema: {
        id: z.string().describe("The file id to fetch"),
        offset: z.number().int().min(0).optional().describe("Start character offset into the readable text (default 0)."),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(`Max characters to return (default and max ${MAX_WINDOW_CHARS}).`),
      },
    },
    ({ id, offset, limit }) =>
      guard(async () => {
        const file = await service.getFile(caller, id);
        const v = file.version;
        const reqOffset = Math.max(offset ?? 0, 0);
        const reqLimit = Math.min(limit ?? MAX_WINDOW_CHARS, MAX_WINDOW_CHARS);

        let text = "";
        let total = 0;
        let appliedOffset = reqOffset;
        let hasMore = false;
        let sourceTruncated = false;
        let pageCount: number | undefined;

        // Bytes come from the unified opener — a managed blob or an external
        // (connector-backed) source — so NAS/GitHub files read like any other.
        if (v && isTextLike(file.name, v.mime)) {
          const stream = await service.openContentStream(file);
          if (stream) {
            const r = await readReadableText(stream, MAX_READ_BYTES);
            total = r.text.length;
            appliedOffset = Math.min(reqOffset, total);
            text = r.text.slice(appliedOffset, appliedOffset + reqLimit);
            hasMore = appliedOffset + text.length < total;
            sourceTruncated = r.truncated; // capped at MAX_READ_BYTES → total is a floor
          }
        } else if (v && docWorker.supportsText(file.name, v.mime)) {
          // PDFs etc.: extract the text layer through the (in-process or container) parser.
          const stream = await service.openContentStream(file);
          if (stream) {
            const { bytes, truncated } = await drainToBytes(stream, MAX_READ_BYTES);
            if (bytes) {
              const r = await docWorker.extractText(bytes, file.name, v.mime, { offset: reqOffset, limit: reqLimit });
              if (r) {
                text = r.text;
                total = r.total;
                appliedOffset = Math.min(reqOffset, total);
                hasMore = r.truncated;
                pageCount = r.pageCount;
              }
            } else {
              // Too large to parse — surface it as truncated rather than silently empty.
              sourceTruncated = truncated;
            }
          }
        }

        return ok({
          id: file.id,
          title: file.name,
          text,
          url: fileUrl(file.id),
          offset: appliedOffset,
          limit: reqLimit,
          total,
          has_more: hasMore,
          truncated: sourceTruncated,
          metadata: {
            path: (file.metadata?.path as string) ?? "",
            mime: v?.mime ?? null,
            size: v?.size ?? null,
            modifiedAt: file.updatedAt,
            ...(pageCount != null ? { page_count: pageCount } : {}),
            ...(Array.isArray(file.metadata?.labels) ? { labels: file.metadata.labels } : {}),
          },
        });
      }),
  );

  server.registerTool(
    "get_outline",
    {
      title: "Get a document outline",
      description:
        "Return a document's structure — page count and headings / table of contents — without its full text, so you can " +
        "decide what to `fetch`. PDFs return their embedded bookmarks (with page numbers where resolvable) and a `pages` " +
        "count; Markdown/text returns its heading hierarchy, `lines`, and `total_chars`; other file types return basic " +
        "metadata only. Headings carry a `level` (1 = top) so you can reconstruct the nesting.",
      inputSchema: { id: z.string().describe("The file id") },
    },
    ({ id }) =>
      guard(async () => {
        const file = await service.getFile(caller, id);
        const v = file.version;
        const base = { id: file.id, title: file.name, mime: v?.mime ?? null };

        if (v && docWorker.supportsText(file.name, v.mime)) {
          const stream = await service.openContentStream(file);
          const { bytes } = stream ? await drainToBytes(stream, MAX_READ_BYTES) : { bytes: null };
          const outline = bytes ? await docWorker.extractOutline(bytes, file.name, v.mime) : null;
          if (outline) {
            return ok({
              ...base,
              kind: "pdf",
              pages: outline.pageCount,
              ...(outline.documentTitle ? { document_title: outline.documentTitle } : {}),
              has_outline: outline.entries.length > 0,
              headings: outline.entries,
            });
          }
        } else if (v && isTextLike(file.name, v.mime)) {
          const stream = await service.openContentStream(file);
          if (stream) {
            const { text, truncated } = await readReadableText(stream, MAX_READ_BYTES);
            const { headings, lines } = textOutline(text, file.name, v.mime);
            return ok({
              ...base,
              kind: "text",
              lines,
              total_chars: text.length,
              truncated,
              has_outline: headings.length > 0,
              headings,
            });
          }
        }

        return ok({ ...base, kind: "other", has_outline: false, headings: [], note: "No outline available for this file type." });
      }),
  );

  server.registerTool(
    "extract_tables",
    {
      title: "Extract tables from a spreadsheet",
      description:
        "Extract a spreadsheet's data as structured rows/columns (one table per sheet) instead of flattened text — so you " +
        "can reliably do operations like sum-by-group or top-N. Works on .xlsx/.xls/.csv and similar; other file types " +
        "return no tables. Each table reports its true `row_count`/`col_count`; rows are capped at `max_rows` per sheet " +
        "(default " +
        DEFAULT_MAX_TABLE_ROWS +
        ") and `truncated: true` flags a table whose rows were cut, so a partial read is never silent.",
      inputSchema: {
        id: z.string().describe("The file id (from `search` or `list_folder`)."),
        sheet: z.string().optional().describe("Limit to one sheet/section by name; omit for all sheets."),
        max_rows: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(`Max rows to return per table (default ${DEFAULT_MAX_TABLE_ROWS}); the full count is in row_count.`),
      },
    },
    ({ id, sheet, max_rows }) =>
      guard(async () => {
        const file = await service.getFile(caller, id);
        const v = file.version;
        const base = { id: file.id, title: file.name, mime: v?.mime ?? null };
        const cap = max_rows ?? DEFAULT_MAX_TABLE_ROWS;

        if (v && docWorker.supportsTables(file.name, v.mime)) {
          const stream = await service.openContentStream(file);
          const { bytes, truncated } = stream ? await drainToBytes(stream, MAX_READ_BYTES) : { bytes: null, truncated: false };
          if (bytes) {
            const out = await docWorker.extractTables(bytes, file.name, v.mime);
            if (out) {
              const selected = sheet ? out.tables.filter((t) => t.section === sheet) : out.tables;
              const tables = selected.map((t) => ({
                section: t.section,
                row_count: t.rowCount,
                col_count: t.colCount,
                confidence: t.confidence,
                ...(t.coverage != null ? { coverage: t.coverage } : {}),
                rows: t.rows.slice(0, cap),
                truncated: t.rowCount > cap,
              }));
              return ok({ ...base, kind: "tables", section_count: out.meta.sectionCount, tables });
            }
          } else if (truncated) {
            return ok({ ...base, kind: "tables", tables: [], truncated: true, note: "File too large to parse." });
          }
        }

        return ok({ ...base, kind: "other", tables: [], note: "No tabular data available for this file type." });
      }),
  );

  server.registerTool(
    "list_folder",
    {
      title: "List a folder",
      description: "List the files and subfolders at a virtual path within a space (defaults to the root of your personal space).",
      inputSchema: {
        path: z.string().optional().describe("Folder path, e.g. \"Documents/2026\". Empty for the space root."),
        space: z.string().optional().describe("Space id; defaults to your personal space."),
      },
    },
    ({ path, space }) =>
      guard(async () => {
        const sp = await spaceFor(space);
        const listing = await service.list(caller.sub, sp, path ?? "");
        return ok({
          space: sp,
          path: listing.path,
          folders: listing.folders,
          files: listing.files.map((f) => ({
            id: f.id,
            name: f.name,
            url: fileUrl(f.id),
            mime: f.version?.mime ?? null,
            size: f.version?.size ?? null,
            modifiedAt: f.updatedAt,
          })),
        });
      }),
  );

  server.registerTool(
    "get_metadata",
    {
      title: "Get file metadata",
      description: "Get a file's metadata (name, path, mime, size, timestamps) without reading its content.",
      inputSchema: { id: z.string().describe("The file id") },
    },
    ({ id }) =>
      guard(async () => {
        const f = await service.getFile(caller, id);
        return ok({
          id: f.id,
          name: f.name,
          path: (f.metadata?.path as string) ?? "",
          mime: f.version?.mime ?? null,
          size: f.version?.size ?? null,
          createdAt: f.createdAt,
          modifiedAt: f.updatedAt,
          metadata: f.metadata,
        });
      }),
  );

  server.registerTool(
    "upload",
    {
      title: "Upload a file",
      description: "Create a new file from text or base64 content. Returns the new file's id and url.",
      inputSchema: {
        name: z.string().describe("File name, e.g. \"notes.md\""),
        content: z.string().describe("File content — UTF-8 text by default, or base64 when encoding is \"base64\"."),
        encoding: z.enum(["utf8", "base64"]).optional().describe("How `content` is encoded (default utf8)."),
        mime: z.string().optional().describe("MIME type; inferred by the client if omitted."),
        path: z.string().optional().describe("Destination folder path within the space."),
        space: z.string().optional().describe("Space id; defaults to your personal space."),
      },
    },
    ({ name, content, encoding, mime, path, space }) =>
      guard(async () => {
        const bytes = decodeContent(content, encoding ?? "utf8");
        const sp = await spaceFor(space);
        const hash = await sha256hex(bytes);
        await service.commitUpload(sp, caller.sub, hash, bytes);
        const file = await service.createFile(sp, caller.sub, { name, hash, mime, path });
        return ok({ id: file.id, name: file.name, url: fileUrl(file.id) });
      }),
  );

  server.registerTool(
    "create_folder",
    {
      title: "Create a folder",
      description: "Create an empty folder at a virtual path within a space.",
      inputSchema: {
        path: z.string().describe("Folder path to create, e.g. \"Documents/2026\"."),
        space: z.string().optional().describe("Space id; defaults to your personal space."),
      },
    },
    ({ path, space }) =>
      guard(async () => {
        const sp = await spaceFor(space);
        return ok(await service.createFolder(sp, caller.sub, path));
      }),
  );

  server.registerTool(
    "move",
    {
      title: "Move or rename a file",
      description: "Move or rename a file by its virtual path within a space. To rename, move to a new path in the same folder.",
      inputSchema: {
        fromPath: z.string().describe("Current path, e.g. \"Documents/old.md\"."),
        toPath: z.string().describe("New path, e.g. \"Documents/new.md\"."),
        space: z.string().optional().describe("Space id; defaults to your personal space."),
      },
    },
    ({ fromPath, toPath, space }) =>
      guard(async () => {
        const sp = await spaceFor(space);
        const res = await service.moveByPath(caller, sp, fromPath, toPath);
        return ok({ moved: true, ...res });
      }),
  );

  server.registerTool(
    "delete",
    {
      title: "Delete a file",
      description: "Move a file to Trash by default, or permanently delete it with `permanent: true`.",
      inputSchema: {
        id: z.string().describe("The file id to delete"),
        permanent: z.boolean().optional().describe("Permanently purge instead of moving to Trash."),
      },
    },
    ({ id, permanent }) =>
      guard(async () => {
        if (permanent) await service.purgeFile(caller, id);
        else await service.deleteFile(caller, id);
        return ok({ deleted: true, permanent: !!permanent });
      }),
  );
}
