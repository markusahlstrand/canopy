# Design: Relationship intelligence (knowledge graph)

> **Status:** design notes, not built. A future plugin plus a few core primitives.
> This page captures a design conversation so the ideas aren't lost. Treat it as an RFC,
> not documentation of shipped behaviour.

## The idea

An entity/relationship intelligence layer — people, companies, clients, competitors, and
**how they tie together** — built from your own documents, emails, and files. A prior
standalone version of this got messy fast. The bet here is that **Canopy is the plumbing
layer that version was missing**, so the rebuild ships as a plugin and spends its effort on
the genuinely hard problems instead of re-inventing storage and ingestion.

It is *not* a CRM clone. CRM is one expression of this; the platform stays general. See
[What belongs in the core](04-what-belongs-in-the-core).

## Why the standalone version rotted

Three failure modes, all at the plumbing layer:

- **Schema churn** — entity and edge types never stop evolving; rigid schema cracks,
  free-form turns to mush.
- **Ingestion sprawl** — every source has its own shape; per-source parsers get tangled
  into storage.
- **No provenance** — a fact with no "where/when did this come from, is it stale" rots
  into untrustworthy soup.

Canopy already factors these out: the connector/adapter pattern handles ingestion, the
[Model editor](plugin-model-editor) handles evolving schema, and the slim-core + plugin
split keeps storage from tangling.

## Core principle: store claims, derive facts

The spine of the whole design. **Never store an AI-extracted value as a fact.** Store it as
a **claim**, and let "facts" be *derived views* computed over the claim set.

A claim is a triple plus metadata:

```
(subject, predicate, object)
  + source_ref          -- exact indexed span the claim came from
  + confidence          -- see "confidence is not one number" below
  + extracted_by        -- model + version
  + valid_time          -- when it was true in the world (e.g. a bill's issue date)
  + ingest_time         -- when we learned it
  + status              -- unverified | confirmed | contradicted
```

This is RDF-star semantics (metadata *on the statement*). Consequences:

- **Demotion is free.** New evidence just changes the computed answer — no rollback, no
  lost history.
- **Proofreading is a click.** `source_ref` points at the highlighted span; re-extract when
  models improve.
- **Tasks are just another claim type** — email/doc → task uses the same pipeline (extract →
  claim → human approves → derive).

### Don't run a triple store

Model claims as a **relational table in D1**, traversed with recursive CTEs (already proven
to work). You get RDF-star expressiveness without the operational tax of a triple store or
SPARQL — and the [Model editor](plugin-model-editor) can export the SQL.

## Confidence is not one number

"Confidence" bundles four orthogonal signals; keep them separate, because promotion is a
function of all four:

- **Extraction confidence** — did the AI read the value correctly?
- **Source trust** — a government bill ≫ an email signature line.
- **Corroboration** — how many *independent* sources agree?
- **Recency / valid time** — when was it true?

A high-extraction-confidence read of a two-year-old bill is still stale.

## Bitemporality: error vs. change

The hard case is contradiction — two bills, two different addresses. Did the data go wrong,
or did the person move? Two timestamps per claim make this mechanical:

- **valid_time** — true-in-the-world date (the document's own date).
- **ingest_time** — when we learned it.

Then:

- Conflict at the **same valid time** → **error** (flag for review).
- Conflict at **different valid times** → **change** (supersession; close the old interval,
  open a new one).

### Per-predicate semantics

How a conflict is interpreted depends on the predicate, so the predicate vocabulary carries:

- **Cardinality** — single (one current address) vs. multi (phone numbers coexist).
- **Temporality** — *immutable* (birthdate: a conflict is **always** an error, dates
  irrelevant) / *interval* (address: cross-time conflict = supersession) / *point-in-time*.

### Reconcile is deterministic, not the LLM

When a claim lands, classify it against existing `(subject, predicate)` claims:

- **corroborates** → bump confidence
- **supersedes** (newer valid time, single cardinality) → close old interval, open new
- **contradicts** (same valid period) → review queue
- **historical** (older valid time) → just store

The AI *extracts* (value + as-of date + confidence). The **classification is rules**, so it
is auditable and the human only ever sees genuine same-period contradictions.

### Promotion policy (per predicate)

Auto-promote to fact when corroborated by **≥2 independent trusted sources**, *or* a single
source with **trust ≥ T and extraction ≥ C** and **no same-period conflict**. Everything else
goes to the review queue.

## Ontology: adopt, don't invent

Layered vocabulary — an always-on **core pack** plus opt-in **domain/locale packs**.

- **Adopt [schema.org](https://schema.org)** for the core (`Person`, `Organization`,
  `PostalAddress`, `email`, `telephone`). Domain packs start from existing standards too
  (FIBO for finance, HL7/FHIR for healthcare).
- **Base "concepts" are typed value-objects, not nodes.** `email` / `phone` / `address` /
  `national-id` carry **validators + normalizers + match rules** (phone → E.164, etc.). Those
  matchers *are* the identity-resolution substrate (dedup) and the corroboration engine
  (cross-document agreement). The definition earns its keep by shipping the matcher, not the
  name.
- **Packs ship as plugins** contributing vocabulary via model-spec — reuse the manifest +
  [Model editor](plugin-model-editor) machinery. Versioned, namespaced (`schema:email` vs
  `pack:field`), with alias→canonical mapping.
- **AI generates pack *candidates*; a human promotes a versioned release.** Never mint
  ad-hoc predicates per document at ingest — that is the vocabulary-sprawl death. A generated
  pack must satisfy the contract: per-predicate cardinality + temporality, per-value-type
  validator/normalizer/matcher.

Flags:

- **National-id is locale-specific** (US SSN ≠ Swedish personnummer ≠ org-nr) → locale packs,
  not the global core.
- **Your strongest match keys are your biggest liability.** SSN/personnummer/email make dedup
  easy *and* make the store a GDPR/PII hotspot. Decide value-type sensitivity tagging early;
  consider hash-for-matching over plaintext.

## Storage & isolation: one D1 per space

D1 is explicitly designed for "per-user, per-tenant or per-entity databases," so **one
database per space** is the blessed pattern, delivered via **Workers for Platforms** (each
space's user Worker carries its own D1 binding, which also sidesteps D1's static-binding
limit).

Verified Workers Paid limits: **50,000 databases per account** (raisable to millions), **10
GB hard cap per database**, **1 TB account storage**, single-threaded **~1000 queries/s** per
database. Per-space sharding is *good* for the graph — it keeps each one small, so recursive
CTE traversal stays fast.

Two things this commits you to:

- **The per-space-vs-global decision.** You cannot JOIN across D1 databases, so a per-space DB
  makes the shard boundary a hard query boundary. Cross-space "how it all ties together"
  (the same person across spaces) needs a separate **global identity/edge index** above the
  per-space DBs. Decide this first — it shapes everything.
- **Migration fan-out.** A churny schema × tens of thousands of DBs needs an idempotent,
  resumable migration runner built early. Don't adopt Workers for Platforms *solely* to shard
  DBs — justify it via per-space plugin isolation, then get per-space D1 for free.

## Consistency: D1 is master, search follows

D1 `batch()` is a single SQLite transaction (all-or-nothing). That splits the sync problem:

- **In-DB FTS5 (today): no dual-write problem.** Put the base-table write and the FTS upsert
  in the **same `batch()`**. Atomicity is free; the only way to break it is to update the
  index in a separate call.
- **External search (Vectorize, later): a real dual-write.** Outbox and Workflows solve
  *different halves*:
  - **Outbox = capture.** Write the change record in the same `batch()` as the data.
  - **Workflows/Queues = delivery.** Durable, retrying application to the external index.
  - **Trap:** never trigger a Workflow from the write path — the commit→trigger gap drops on
    isolate death. Drive the consumer from the committed log/cursor.

**You already own the outbox.** The offline-mirror per-space monotonic `seq` +
`/api/changes` feed *is* a changelog (see [Sharing and spaces](08-sharing-and-spaces)).
Search is just another consumer with its own cursor. The one correctness check that matters:
**is the `seq` write in the same `batch()` as the mutation?** If yes, nothing can be lost.

Backstops: idempotent apply keyed by `(entity_id, seq)` (at-least-once is then safe), and a
scheduled reconcile sweep diffing D1 vs. index to catch drift the outbox can't.

## Core primitives worth lifting from micro.so

[micro.so](https://www.micro.so) is a closed, vertical AI CRM. We keep its scope as a plugin,
but two of its patterns belong in **Canopy core** because every plugin benefits:

1. **Proposals inbox (highest leverage).** A host-provided "AI proposes → human approves"
   surface any plugin can post to (proposal = source span + confidence + suggested action +
   accept/dismiss). Build once; claim-promotion *and* task-generation both flow through it.
2. **Assistant command surface.** A portal-wide command bar + assistant that plugins
   contribute actions and context to via the plugin SDK. This is what makes Canopy feel like
   one product instead of a folder of plugins.

Plus **cross-space natural-language search** over the existing FTS5 index (NL → structured
query now; semantic ranking once Vectorize lands).

Plugin-level ideas from the same source: self-updating records (the claims pipeline),
relationship-strength scoring (a derived view — needs interaction events as a first-class
type), typed extraction templates per source, and mobile-first quick capture.

**Do not** absorb micro's CRM scope into the core. Core stays the platform; CRM stays a
plugin.

## The two hard problems Canopy won't hand you

Everything above is plumbing the platform provides. These two are yours to solve, and they
are the same problem seen twice:

- **Identity resolution / dedup** — "is this the same person across sources?" A triple is only
  as good as the entity IDs in it; bad dedup gives a pristine graph of duplicates. The
  value-type matchers are the substrate; the resolution logic on top is the work.
- **Semantic graph discovery** — "how does it all tie together" beyond exact matches. Needs
  **Vectorize** (currently deferred).

## Suggested sequencing

1. **Claims + core-pack schema** in the [Model editor](plugin-model-editor) — the foundation
   everything else embeds. Model the core pack first (Person/Org/Place + value types with
   their matchers).
2. **Proposals inbox** — cheap, high-leverage, unblocks the approve loop for both
   claim-promotion and task-generation.
3. **Vectorize** — the first real enhancement, once there are entities/claims worth embedding.
   Embed *entities* (name + aliases + key attributes), not just document chunks, so semantic
   dedup works. Turning it on is also when the external-search consumer (above) goes live.

## See also

- [What belongs in the core](04-what-belongs-in-the-core) — the core-vs-plugin decision rule.
- [Model editor](plugin-model-editor) — where the claims + ontology schema gets modelled.
- [Sharing and spaces](08-sharing-and-spaces) — the `seq` change feed reused as the outbox.
- [Tasks](plugin-tasks) — the existing task view this would feed with extracted tasks.
