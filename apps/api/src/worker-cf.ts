// Cloudflare Worker entry (wrangler `main`). It exists only to re-export the
// runtime-agnostic Worker handler alongside the Cloudflare-only Durable Object
// class, so the DO's `@cloudflare/containers` dependency stays isolated to the
// `container/` directory (excluded from the main `tsc` typecheck) and never
// leaks into the rest of `apps/api`. The Node entry (`node.ts`) ignores all of
// this.
export { default } from "./worker";
export { DocWorker } from "./container/docworker-do";
