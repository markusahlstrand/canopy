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
import { documentTextExtractor } from "../extract";

/** Cap on the bytes `fetch` returns inline as text (matches the indexer's cap). */
const MAX_TEXT_BYTES = 512 * 1024;

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

/** Read up to `cap` bytes of a stream and decode as UTF-8 (lossy). */
async function readText(stream: ReadableStream<Uint8Array>, cap: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(Math.min(total, cap));
  let off = 0;
  for (const ch of chunks) {
    if (off >= buf.byteLength) break;
    const n = Math.min(ch.byteLength, buf.byteLength - off);
    buf.set(ch.subarray(0, n), off);
    off += n;
  }
  return new TextDecoder().decode(buf);
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
        "Fetch a file's full text content and metadata by id (ids come from `search` or `list_folder`). PDFs return their extracted text layer; other binary files return metadata and a download `url` with empty text.",
      inputSchema: { id: z.string().describe("The file id to fetch") },
    },
    ({ id }) =>
      guard(async () => {
        const file = await service.getFile(caller, id);
        const v = file.version;
        let text = "";
        if (v && v.source === "blob" && v.blobKey) {
          const { key } = await service.getContentKey(caller, id);
          if (isTextLike(file.name, v.mime)) {
            const stream = await drive.blobs.get(key);
            if (stream) text = await readText(stream, MAX_TEXT_BYTES);
          } else if (documentTextExtractor.supports(file.name, v.mime)) {
            // PDFs etc.: return the extracted text layer instead of empty text.
            const stream = await drive.blobs.get(key);
            if (stream) text = (await documentTextExtractor.extract(stream, file.name, v.mime)) ?? "";
          }
        }
        return ok({
          id: file.id,
          title: file.name,
          text,
          url: fileUrl(file.id),
          metadata: {
            path: (file.metadata?.path as string) ?? "",
            mime: v?.mime ?? null,
            size: v?.size ?? null,
            modifiedAt: file.updatedAt,
            ...(Array.isArray(file.metadata?.labels) ? { labels: file.metadata.labels } : {}),
          },
        });
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
