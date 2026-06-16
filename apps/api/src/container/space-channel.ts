// Durable Object: the per-space live-sync channel (Cloudflare-only).
//
// ISOLATION: like docworker-do.ts, this is reached only through worker-cf.ts and is
// EXCLUDED from apps/api's main `tsc` typecheck (which has no Cloudflare runtime
// types). Wrangler/esbuild transpiles it at deploy; Node never imports it.
//
// One instance per space id. It holds the set of open Server-Sent-Events connections
// for that space and, when the Worker posts a `/notify` (fired from FileService's
// `onSpaceChanged` after a write advances the space's seq), broadcasts a one-line
// "bump" to every listener. The payload carries NO file data — only "this space
// advanced to seq N, go pull" — so the entire ACL surface stays in `GET /api/changes`,
// which re-checks access. The DO holds no storage; it lives only while a stream is open.

export class SpaceChannel {
  private readonly writers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private readonly enc = new TextEncoder();

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_state: DurableObjectState, _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const space = url.searchParams.get("space") ?? "";

    // Worker → DO: a write advanced this space. Fan out to listeners.
    if (url.pathname.endsWith("/notify")) {
      const seq = Number(url.searchParams.get("seq") ?? "0");
      this.broadcast(space, Number.isFinite(seq) ? seq : 0);
      return new Response(null, { status: 204 });
    }

    // Worker → DO: an index run emitted a progress line. Unlike `bump`, this payload
    // IS the data (the log line) — it's transient progress, never persisted, and
    // carries no file contents, so the same open-to-a-space-you-can-read gate applies.
    if (url.pathname.endsWith("/log")) {
      const line = (await request.json().catch(() => null)) as {
        message?: unknown;
        level?: unknown;
        ts?: unknown;
      } | null;
      this.broadcastIndex(space, {
        message: typeof line?.message === "string" ? line.message : "",
        level: line?.level === "error" ? "error" : "info",
        ts: typeof line?.ts === "number" ? line.ts : 0,
      });
      return new Response(null, { status: 204 });
    }

    // Client → DO: open an SSE stream held until the client disconnects.
    let self!: ReadableStreamDefaultController<Uint8Array>;
    const writers = this.writers;
    const enc = this.enc;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        self = controller;
        writers.add(controller);
        // An initial event so the client knows the stream is live (and to flush headers).
        controller.enqueue(enc.encode(`event: ready\ndata: ${JSON.stringify({ space })}\n\n`));
      },
      cancel: () => {
        writers.delete(self);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  }

  private broadcast(space: string, seq: number): void {
    this.send(this.enc.encode(`event: bump\ndata: ${JSON.stringify({ space, cursor: seq })}\n\n`));
  }

  private broadcastIndex(space: string, line: { message: string; level: "info" | "error"; ts: number }): void {
    this.send(this.enc.encode(`event: index\ndata: ${JSON.stringify({ space, ...line })}\n\n`));
  }

  private send(msg: Uint8Array): void {
    for (const c of [...this.writers]) {
      try {
        c.enqueue(msg);
      } catch {
        this.writers.delete(c); // closed underneath us — drop it
      }
    }
  }
}
