---
name: implement-cloudflare-hono
description: Turn a Canopy app spec (`.tsp` / `.arazzo`) into a best-practices app on the Canopy house stack — Hono + Zod + jose/OIDC on Cloudflare Workers (dual Node runtime), with the adapter/connector pattern and a slim core + plugins. Use when the user wants to implement, scaffold, or wire up endpoints/an app from the model spec ("implement this spec", "build the API for these entities", "wire up the Episode endpoints"). Input is the spec; pair with `model-spec`, which produces it.
---

# Implement a spec on the Cloudflare + Hono stack

You turn an app **spec** (entities/endpoints/flows, produced by the `model-spec` skill) into running
code on the Canopy house stack. The spec is the contract; you generate the implementation that
satisfies it — and you keep it best-practices for *this* stack, not generic.

This is one of potentially several `implement-*` skills. It owns exactly one target: Cloudflare
Workers + Hono. The spec stays stack-agnostic; the opinions live here.

## Step 0 — Read the contract first

Before writing code, read:

- `.claude/skills/implement-cloudflare-hono/stack.md` — the stack conventions + spec→code mapping.
  **Read it every time.**
- The spec you're implementing: `apps/api/spec/*.tsp` (+ any `.arazzo`). This is the source of truth
  for *what* to build.
- The existing app for the patterns to match — don't reinvent: `apps/api/src/app.ts` (Hono wiring),
  `apps/api/src/worker-cf.ts` + `node.ts` (dual runtime entrypoints), `apps/api/src/auth/` (jose/OIDC),
  and the relevant `@canopy/connector-*` / `@canopy/core` / `@canopy/store` packages.

Match the real shapes. If a pattern exists in the codebase, follow it rather than introducing a new one.

## Step 1 — Map the spec to the stack

Work entity-first, the same order the spec is anchored. For each piece, see `stack.md` for the
concrete pattern. In short:

| Spec | Becomes |
|---|---|
| Entity (`@key` model) | a Zod schema + a store/adapter type; persistence via `@canopy/store` |
| Endpoint (`interface` op) | a Hono route, validated with Zod, returning the spec's DTO shape |
| Auth on an op | jose-verified bearer / OIDC middleware; ownership scoping |
| DTO `model` | a Zod schema for the request/response body |
| Flow (Arazzo) | the ordering/guards across the endpoints it sequences |

Generate the routes to **honour the spec's `operationId`s** — they're the join between layers and the
emitted OpenAPI. Don't drift names.

## Step 2 — Hold the line on house style

These are non-negotiable for this stack (detail in `stack.md`):

- **Dual runtime** — code runs on both Workers (`worker-cf.ts`) and Node (`node.ts`); don't reach for
  Node-only or CF-only APIs in shared code. Put runtime-specific bits behind the existing seams.
- **Adapters over direct deps** — storage, connectors, and external services go through
  `@canopy/store` / `@canopy/connector-*` interfaces, not inline SDK calls. Slim core, capability via
  plugins.
- **Validate at the boundary** — Zod on every request body/query; trust internal calls.
- **OIDC, not bespoke auth** — bearer verification through the existing `auth/` + jose; never hand-roll
  token logic.
- **Keep latest deps** — match the versions already in `apps/api/package.json` (Hono 4, Zod 4, jose 6).

## Step 3 — Verify before claiming done

Run the real checks and report honestly (don't declare success on an unrun build):

- the spec still compiles and the OpenAPI emits (`@typespec/openapi3` is wired in `apps/api`)
- `tsc` typechecks the new code
- routes match the spec's `operationId`s and DTO shapes
- new external dependencies go through an adapter, not a direct import

If something doesn't pass, say so with the output. If a step was skipped, say that.

## Don't

- Don't generate generic Express/Node boilerplate — this stack is Hono on Workers.
- Don't add features, tables, or endpoints the spec doesn't call for. Implement the contract; the spec
  is where scope changes happen (hand back to `model-spec`).
- Don't bypass the adapters to "just call the SDK" — that's the thing this stack exists to avoid.
