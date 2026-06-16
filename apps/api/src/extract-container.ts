import {
  inProcessDocWorker,
  isPdf,
  isSpreadsheet,
  type DocOutline,
  type DocTables,
  type DocWorker,
  type RangedText,
  type TextWindow,
} from "@canopy/docworker";

/**
 * The minimal slice of a Durable Object namespace we need to reach the container.
 * Declared structurally so this file — and `worker.ts` which imports it — stay
 * free of `@cloudflare/workers-types` (the repo duck-types all Cloudflare
 * bindings). The actual `Container` subclass lives in `container/docworker-do.ts`,
 * isolated behind the `worker-cf.ts` entry.
 */
export interface ContainerNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

/**
 * A {@link DocWorker} that offloads parsing to the document container over the
 * internal Worker→DO hop — for heavy/large documents and tailnet-only sources the
 * isolate can't handle itself.
 *
 * Auth: the DO binding is the security boundary (a Cloudflare Container has no
 * public ingress; only the bound Worker can reach it), so no shared secret is
 * required. `token` is optional defense-in-depth that, when set, is checked by the
 * service too.
 *
 * Resilience: if the container is unreachable — e.g. deployed worker-only with
 * `--containers-rollout=none`, or transiently unhealthy — every method falls back
 * to the in-process parser, logging once. So enabling the binding is always safe;
 * the container is a pure accelerator, never a hard dependency. (The fallback runs
 * in the isolate, so it can't reach a tailnet-only source — that path inherently
 * needs the container — but it parses any bytes the Worker already holds.)
 */
export function containerDocWorker(ns: ContainerNamespace, token?: string, instance = "docworker"): DocWorker {
  const local = inProcessDocWorker();

  const post = async <T>(path: string, bytes: Uint8Array, name: string, mime?: string | null): Promise<T | null> => {
    const stub = ns.get(ns.idFromName(instance));
    const res = await stub.fetch(
      new Request(`http://docworker${path}`, {
        method: "POST",
        headers: {
          ...(token ? { "x-docworker-token": token } : {}),
          // Percent-encode so a non-Latin1 name (CJK, emoji, …) can't throw when
          // set as a header value and spuriously trigger the in-process fallback.
          // `docMeta` in apps/docworker/src/app.ts decodes the matching pair.
          "x-doc-name": encodeURIComponent(name),
          ...(mime ? { "x-doc-mime": mime } : {}),
          "content-type": "application/octet-stream",
        },
        body: bytes as unknown as BodyInit,
      }),
    );
    if (!res.ok) throw new Error(`docworker container returned HTTP ${res.status}`);
    return (await res.json()) as T | null;
  };

  /** Run a container call, falling back to in-process parsing if it throws. */
  const withFallback = async <T>(call: () => Promise<T | null>, fallback: () => Promise<T | null>): Promise<T | null> => {
    try {
      return await call();
    } catch (err) {
      console.warn(`[docworker] container unavailable, parsing in-process: ${(err as Error).message}`);
      return fallback();
    }
  };

  return {
    supportsText: isPdf,
    supportsTables: isSpreadsheet,
    extractText: (bytes, name, mime, opts?: TextWindow) => {
      const qs = new URLSearchParams();
      if (opts?.offset != null) qs.set("offset", String(opts.offset));
      if (opts?.limit != null) qs.set("limit", String(opts.limit));
      const q = qs.toString();
      return withFallback(
        () => post<RangedText>(`/extract${q ? `?${q}` : ""}`, bytes, name, mime),
        () => local.extractText(bytes, name, mime, opts),
      );
    },
    extractOutline: (bytes, name, mime) =>
      withFallback(
        () => post<DocOutline>("/extract/outline", bytes, name, mime),
        () => local.extractOutline(bytes, name, mime),
      ),
    extractTables: (bytes, name, mime) =>
      withFallback(
        () => post<DocTables>("/extract/tables", bytes, name, mime),
        () => local.extractTables(bytes, name, mime),
      ),
  };
}
