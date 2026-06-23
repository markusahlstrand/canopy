---
name: model-spec
description: Design and edit the Canopy app model — entities, endpoints, events, and flows — as the spec files the model-editor renders (`.tsp` / `.arazzo` / `.prisma`). Stack-agnostic: produces the contract, not the implementation. Use when the user wants to model a domain or app ("model a podcast app", "add a Subscription entity", "design the publish flow", "what endpoints does Episode need"). Pair with an `implement-*` skill to turn the spec into a running app.
---

# Model a Canopy app spec

You design and edit the **app spec** — the source-of-truth files the model-editor renders on its
canvas. The spec is stack-agnostic: it says *what* the app is, never *how* it's built. A separate
`implement-*` skill turns this spec into a running app for one stack.

The files ARE the interface. You edit text; the canvas reacts (the editor live-reloads on external
change). You never need a canvas API.

## Step 0 — Read the contract first

Before editing, read these so you match the real shapes:

- `.claude/skills/model-spec/conventions.md` — the layered AppSpec vocabulary + best-practices
  conventions (this is the source of truth for *good* modelling). **Read it every time.**
- `apps/api/spec/main.tsp` + `apps/api/spec/models.tsp` — the canonical, hand-written example of a
  well-formed spec. Match its idioms (`@route`, `@operationId`, `@useAuth`, `@key`, doc comments).
- The file(s) you're about to edit. If none exist yet, create them next to where the app lives.

Do not invent TypeSpec/Arazzo constructs. If it isn't in `conventions.md` or the example specs, check
the official compiler before using it.

## Step 1 — Establish scope, then act

For a **new app** with a recognizable domain ("a podcast app"), do NOT interview — produce a complete
first-draft model immediately, then ask what to refine. Only ask a clarifying question when the domain
is genuinely ambiguous about *what* to build.

For an **edit**, make the smallest change that satisfies the request, then check the layer is still
consistent (see Step 3).

## Step 2 — Work the layers (entities are the anchor)

The model is one co-evolving spec across four layers. Edit any layer on any turn; they reference each
other, so a change in one often implies a change in another. Always keep the layers consistent.

| Layer | Lives in | Shape |
|---|---|---|
| **Entities** + relations | `models.tsp` (or `.prisma`) | TypeSpec `model` with a `@key`; refs between models |
| **Endpoints** | `main.tsp` (or sibling `.tsp`) | `interface` with `@route` ops, each `@operationId` |
| **Flows** | `*.arazzo.(yaml\|json)` | Arazzo workflow; steps reference ops by `operationId` |
| **Events** | not yet represented | model the data + note "behaviour not yet in the spec" |

Apply the conventions from `conventions.md` automatically — every entity gets a primary key and CRUD
endpoints, list endpoints paginate, mutations with side effects imply an event, flows tie a user
intent to endpoints. Don't make the user ask for the obvious supporting pieces; propose them.

## Step 3 — Keep it buildable (completeness pass)

After a change, scan for gaps — these are what turn a sketch into a spec, and they're the next round
of work, not errors to hide:

- entity with no endpoints; endpoint touching no entity
- `operationId` referenced by a flow but not defined (and vice-versa)
- relation pointing at a deleted/renamed model
- an event with no producer or no subscriber (once events exist)

The editor's `DiagnosticsBar` already flags dangling `operationId`s and deleted-model refs — surface
anything it would, plus the coverage gaps above. State the gaps; offer to fill them.

## Round-trip rules (don't lose work)

- **`.tsp` / `.arazzo` are the source of truth** and round-trip cleanly. Prefer them.
- **`.prisma` is lossy by default** — `uuid`/`text` collapse to `String`, `@default`/`@@`-attrs and
  comments drop on the pure-Prisma path. If exact types/positions matter, the editor's "Embed
  metadata" option writes a `// @canopy-model {json}` header for a lossless restore. Don't hand-strip
  that header.
- **Node positions/colors live in a `canopy.layout.json` sidecar**, not in the model files. Don't put
  layout in the spec; let the canvas auto-layout, or edit the sidecar if asked.
- Don't delete DTO `model`s (request/response payloads) thinking they're stray entities — they're the
  typed operation contract. Entity vs DTO is: a model is an **entity** if it has `@key` or is reachable
  from a `@key` model; everything else is a DTO.

## Hand-off

When the user wants this built, point them at the matching `implement-*` skill (e.g.
`implement-cloudflare-hono`). The spec you produced is its input — you stay stack-agnostic.
