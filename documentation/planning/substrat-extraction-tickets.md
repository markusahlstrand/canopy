# Substrat convergence rail (canopy side)

*Revised 2026-09-20 against substrat @ `ecac7249`. The previous revision (2026-07-14) is
superseded in most of its particulars — not in its direction.*

Canopy is still Substrat **consumer #2** per decision **D-17** (2026-07-12, unchanged and
re-stated verbatim in master-plan §decision table row 17): the document product's engine
*extracts into* the kernel, and the product *re-platforms onto* the kernel piecemeal —
never integrated as an external document service behind its own permission regime (two
enforcement systems = the exact leak the kernel exists to prevent). Extraction is timed by
case-1 need; re-platforming is opportunistic.

What has changed is the balance of power between the two repos.

---

## 0. Two reality checks

**Substrat, today.** 1 395 commits since 2026-07-13, releasing continuously through
changesets. Not a scaffold in any sense the July doc assumed:

| July assumption | September reality |
|---|---|
| "0.1.0, engines `workorder`/`invoicing` scaffolded" | 7 engines (`absence`, `booking`, `invites`, `invoicing`, `metering`, `protocol`, `workorder`), 3 connectors (`fortnox`, `planima`, `scrive`), 7 apps (`builder`, `console`, `control-plane`, `dashboard`, `docs`, `router`, `vertical-egress`) |
| "`@substrat-run/adapter-cloudflare` is planned but unbuilt" | **Built**: `d1.ts`, `r2.ts`, `scope-do.ts`, `checker.ts`, `control-plane-do.ts`, `platform-sweeper-do.ts`, `route-resolver.ts`, `sql.ts`. `adapter-sqlite` beside it, D-14 held |
| "kernel design doc covers the contract" | 23 packages; `contracts` is 30 modules of shipped Zod; `contract-tests` is 22 conformance suites (scope-host, permission, search, schedule, timeline, concurrency, idempotency, impersonation, spine-guard, …) |
| "documents deferred; search backends undecided" | Attachments spine + per-tenant blob stores landed (#473); kernel-owned FTS derived from `manifest.searchables` (#827). Semantic search still deferred — DO SQLite rejects `vec0` (kernel-design §947) |
| "the integrations hub is deferred past milestone 1" | `contracts/connections.ts`, `ConnectorHandler`, reconcile sweeps, health, dead-letters — shipped |
| "milestone 1 is case 1 (PropCo)" | The hosted product is the near milestone: builder studio, control plane, dashboard, marketplace publish, metering/billing, Workers-for-Platforms routing (D-33, D-48…D-60) |
| 17 decisions | 102 decision records: D-001…D-060 plus K-001…K-042 |

Async work is no longer an empty row in a matrix. The kernel has **executors**
(`ExecutorHandler`, per-executor retry policy, dead-letter, `drainDue`), **declared
schedules** (`ScheduleRegistration` / `runDueSchedules`, #383), **freshness checks**
(#1232), a **platform sweep** on a timer (`platform-sweep.ts`, `docs/architecture/scheduler.md`,
status *built*), an **invocation log** (#1237), a **denial log** (K-35), **impersonation**
(K-42), **sub-transactions**, and kernel-composed **paging** (K-41).

**Canopy, today.** `main` @ `b2178e2`, last commit **2026-07-12** — static for two months.
Jobs rail T1 (runs table) is merged; T2 (jobs port + in-process adapter) sits on the
unmerged `feat/jobs-port` / `feat/jobs-role`; **T3 (the CF Workflow dispatcher) was never
started**. The working tree holds the jobs-role WIP (`plugin-roles.ts`, `plugins.ts`,
`canopy-plugin.schema.json`) plus this untracked planning directory.

**The inversion.** July's rail was written from "canopy has proven adapters, substrat has
designed contracts." That premise is gone: substrat built its own Cloudflare adapter, its
own conformance suites, its own scheduler and its own blob/attachment surface while canopy
stood still. Canopy no longer arrives with infrastructure. It arrives with a **domain**
(documents, versioning, content search, offline) and a handful of **specific mechanisms**
substrat has not needed yet. The rail below is re-cut on that basis.

**The crux is unchanged and still the biggest risk:** canopy's store is one shared DB with
`spaceId` columns; substrat's semantics are scope-isolated — one hop, then local queries,
strict per-scope serialization, data reachable only via `ScopeStub`. Re-platforming means
moving drive operations *inside* scope stubs (space = scope, Shape A). That is a genuine
re-architecture of `packages/store`, not a mechanical lift. Two months of substrat commits
have made the target tighter, not looser.

---

## 1. What actually moves from canopy to substrat

Three classes, and the classification matters more than any individual line: **move** =
substrat has no answer and wants one; **converge** = substrat's answer wins and canopy
adopts it, deleting its own; **stays** = product surface that belongs to consumer #2 and
would be a foreign body in the kernel.

### A. Moves into substrat (canopy is the source)

| Canopy | Lands as | Why it moves |
|---|---|---|
| `files.ts` (2.6k) — path tree, versioning, snapshots; `blobs.ts`; `retention.ts` (tiered keep-curve) | The documents service D-17 names, on top of the attachment spine (#473) + per-tenant blob stores | Substrat has *flat, entity-attached* files with a sha256 witness. It has no tree, no version chain, no retention curve. This is the D-17 payload proper |
| `docworker` extract pipeline + `search.ts` FTS feed | Content indexing behind `ctx.search` | The kernel indexes *declared entity fields*. Nothing extracts text from a blob and indexes that. A documents service without it is a filename search |
| `search-ai.ts` (Cloudflare AI Search / AutoRAG adapter) | The deferred semantic half of kernel search | kernel-design §947 defers semantic search because DO SQLite rejects `vec0`. Canopy's adapter answers it from *outside* the scope DB, which is the only shape that works today. **Highest value per line of code on this list** |
| `jobs.ts` + `runs.ts` — coalescing per `pluginId:name:instanceKey`, resume cursor, per-step retry, JSON-payload rule, run records | A kernel long-job contract, *if and when* a substrat consumer needs one | Executors retry one delivery; schedules fire an operation inside a cadence window; the sweep is platform-grain. None of the three is "one in-flight crawl per instance, resumable from a cursor, over 100k objects." Indexing a documents scope needs exactly that — so this moves **with S9, not before it** |
| `connectors/{synology,github,local,r2}` | A *storage* connector shape beside the business-API connectors (`fortnox`, `scrive`, `planima`) | The connector framework exists; its examples are all "call an API, reconcile a record." A connector that enumerates and streams bytes is a second shape worth proving — but only once there is a documents service for it to feed |
| `@canopy/mirror` + per-space seq-delta `/api/changes` + `SpaceChannel` SSE | A written answer to master-plan's open question *"Offline scope for fältpersonal (case 1): which flows must work offline, and is append-only capture sufficient?"* | Canopy has shipped read-only offline against a real event feed. Contribute the **design** into `docs/architecture/` first; code follows a decision, not the other way round |
| `packages/model-editor` (React Flow ER editor, exports) | The interactive half of `model-view` / the dashboard's Model tab (#1214) | `model-view` renders a static, script-free HTML page from `model.json`. Canopy has the editor. The port is a retarget: `.tsp`/`.prisma` round-trip out, `emittedModel` (the artifact of record, #697) in |

### B. Converges onto substrat (substrat's contract wins; canopy deletes)

| Canopy | Substrat surface it converges onto |
|---|---|
| `db-d1.ts`, `blob-r2.ts`, `blob-fs.ts`, `db-libsql.ts` | `@substrat-run/adapter-cloudflare` + `adapter-sqlite` — **already built**. Canopy stops maintaining these; July's "seed the CF adapter from canopy" is dead |
| `index-jobs.ts` dispatch, T3's would-be CF Workflow dispatcher | `ExecutorHandler` + retry policy + `drainDue`, `ScheduleSpec` + `runDueSchedules`, `runPlatformSweep`. **Do not build T3 as designed** — it duplicates a shipped driver |
| `authz.ts`, `folder-grants`, `shares.ts` | Kernel permission checker + `permission-eval` + the required permission registry (D-47) + denial log (K-35). Canopy's grant tables become a migration target, not a contract |
| `users.ts`, `invites.ts`, `app-passwords.ts`, authhero/OIDC glue | `vertical-auth`, `oidc-rp`, `dev-issuer`, identity pools (K-23/K-25), `engines/invites`. Authhero becomes *the issuer behind the adapter*, not a parallel identity system |
| `canopy-plugin.schema.json`, `plugin-roles.ts`, `plugin-installs`, `plugin-settings` | `contracts/manifest.ts` + the deploy manifest + the permission registry |
| `sync.ts` change feed, any future audit table | The event spine: outbox, envelope (K-34 records what authorized it), invocation log, lake drain. Audit arrives as a consequence, never as a second table |
| `scheduling.ts` (625 LOC — JSCalendar calendars/events/tasks on folder grants) | `engines/booking` + `engines/absence`. **Correction to the July doc:** this is a calendar *domain*, not platform scheduling; it does not seed an `engine-scheduling`, and its dispatch machinery does not belong in the jobs contract |
| `apps/api/src/mcp` tool surface | `vertical-host/src/mcp.ts`. Canopy's `mcp_clients` connection tracking stays product-side |

### C. Stays in canopy

- **The sandboxed-iframe plugin runtime**, plugin browser and studio. K-15 *rejects runtime
  microfrontends*: UI composition is build-time, and a web-component slot is the only
  sanctioned escape hatch. Canopy's runtime plugin model is a deliberate divergence, and the
  already-deferred web-components work (`@canopy/plugin-sdk` item C) is the one seam where
  the two models could ever meet.
- **The portal**, the welcome/marketing plugin, POSITIONING.md, the drive UX. Product.
- **Space/drive-shaped product decisions** that have no kernel meaning: the rail, the
  viewer registry, the offline UX.

---

## 2. The rail, re-cut

Status per ticket: **live** (as written, or close), **re-aimed** (same intent, wrong
target in the July text), **dead** (substrat solved it).

### S1 — Mapping doc: canopy onto the scope model · **live, re-aimed**

Still the first thing, and now cheaper to get right because there is more to map onto.
Target directory moved: `docs/design/` no longer exists — kernel design lives in
`docs/architecture/kernel-design.md`, decisions in `docs/decisions/`. Map: canopy user →
tenant; **space → scope** (`kind: 'space'`, Shape A, `jurisdiction: 'eu'` — note K-32 made
`global` a first-class jurisdiction); portal + plugins → vertical. Enumerate the mismatches
honestly: shared-DB vs scope isolation (the crux), folder grants vs the kernel's path-based
model and its registry (D-47), the changes feed vs the spine, canopy's runtime plugin model
vs K-15's build-time composition, canopy's list endpoints vs K-41 paging.

*Acceptance:* mapping doc merged in substrat `docs/architecture/`; open questions filed
against kernel-design's open-question list, not resolved ad hoc.

### S2 — Converge the jobs port · **re-aimed (was: merge canopy's Jobs into the contract)**

Substrat did not wait. Read `ExecutorHandler`/`ExecutorRetryPolicy`/`drainDue`,
`ScheduleRegistration`/`runDueSchedules`, and `platform-sweep.ts` first, then state in one
page which of canopy's jobs needs are *already served* and which are genuinely missing (the
candidate: coalesced, cursor-resumable, long-running work — see A above). Canopy's jobs rail
tickets T3–T13 get re-scoped against that answer; T3 as specified is dead.

*Acceptance:* a gap statement, not a port; every canopy job either maps to a shipped kernel
driver or is named as a proposed kernel addition with the consumer that needs it.

### S3 — Contract-tests bridge in canopy CI · **live, inverted**

July had canopy *donating* suites. Now canopy *consumes* them: `@substrat-run/contract-tests`
ships 22 suites, and canopy's job is to run the relevant ones against its own
implementations as they converge. Donation is limited to whatever S2 proves is missing.

*Acceptance:* canopy CI runs at least `scope-host`, `permission` and `search` suites against
canopy adapters as those land; failures are canopy's bug, not substrat's.

### S4 — Runs + scheduling convergence · **partly dead, partly re-aimed**

Dead half: `scheduling.ts` is JSCalendar, not cron; there is no `engine-scheduling` to seed,
and `booking`/`absence` already occupy that space. Live half: `runs.ts` retention and run
bookkeeping ride along with S2's gap statement and land, if at all, with S9.

### S5 — Contribute the Cloudflare adapter · **dead**

`@substrat-run/adapter-cloudflare` was built without canopy. The ticket inverts: canopy
*adopts* it and deletes `db-d1.ts` / `blob-r2.ts` / the libsql and fs halves as the
re-platform reaches each. Book that as part of S10.

### S6 — Identity + permissions convergence · **live, larger target**

Unchanged in intent; the surface to converge onto is much bigger (`vertical-auth`, `oidc-rp`,
identity pools K-23/K-25, `engines/invites`, the required permission registry D-47, denial
log K-35, impersonation K-42). Expect the kernel model to win, and walk canopy's real sharing
cases against it before assuming it does.

*Acceptance:* canopy auth flows unchanged end-to-end; permission checks route through the
kernel checker; mismatches filed as kernel amendments, not canopy forks.

### S7 — Module manifest convergence · **live, with one correction**

The July acceptance bar ("the agent-loop test §11.4") **no longer exists**: D-57 retired the
benchmark on 2026-08-19; the eight run records stay as historical evidence. Use the mechanical
gates instead — `lint:permissions`, `lint:model`, `lint:api`, `lint:decisions`, boundary-lint,
migration replay, contract tests on both adapters. And carry the honest conflict into the
mapping: canopy's trusted-vs-sandboxed plugin distinction has no counterpart in a manifest
built for build-time composition (K-15).

### S8 — Event spine adoption · **live, cheaper**

The spine now carries what canopy would have had to ask for: envelopes recording what
authorized them (K-34), per-event invocation linkage (#1237), the outbox drain, the lake.
The mirror becomes a spine consumer; audit arrives free.

### S9 — Documents service extraction (D-17 proper) · **live, and now the main event**

Unchanged in scope, much better landed: attachments (#473) give the metadata-row-inside-the-
scope / bytes-in-a-platform-store split; per-tenant blob stores exist; `attachmentBlobKey`
pins key derivation; the kernel search index exists for the FTS half. What canopy adds is
everything the July doc listed — tree, versioning, retention, content extraction, connector
sync — plus the semantic half (A above). Timing is still case-1 need per D-17; canopy must
not block on it.

*Acceptance:* documents service passes contract tests on both adapters; canopy is its first
consumer for at least one operation class (versioned write + read).

### S10 — Re-platform canopy piecemeal · **live, unchanged, still the long tail**

Reads → metadata writes → blob writes → WebDAV, one class at a time into scope-stub
operations. `apps/api/src/app.ts` (1.8k) decomposes as operations migrate. Integrations now
*can* move earlier than July assumed — the connector framework shipped — but they should
still follow the documents service, not precede it.

### S11 — *(new)* Decide whether canopy becomes a hosted vertical · **open question**

Substrat's near milestone is the hosted product, and D-60 makes even the dashboard "an
ordinary sandbox-clean vertical." That creates an option that did not exist in July: canopy
runs *on* the platform (router, control plane, provisioning, metering) rather than only
converging with its contracts. It also collides head-on with K-15 and canopy's runtime plugin
model. Decide deliberately — do not drift into it.

---

## 3. Sequencing, and the honest position

- **S1 first, and soon.** Every other ticket's estimate is currently guesswork, because the
  July mapping was written against a substrat that no longer exists.
- **S2 before any more jobs-rail work.** T3 as specified duplicates a shipped driver. Finish
  or abandon the `feat/jobs-port` branch on that answer, not before.
- **S6/S7/S8 interleave with product work**; each is independently shippable.
- **S9/S10 stay case-1-timed** per D-17, and the re-platform must not become a third
  greenfield (master-plan open question, still open).
- **The discipline rule stands, with its dual:** nothing enters the kernel canopy doesn't
  consume immediately — and where substrat has a shipped contract, canopy converges rather
  than exporting its own shape. Two months of drift is what the second half is for.
- **The uncomfortable fact:** canopy has been static since 2026-07-12. The longer that runs,
  the more of this document is convergence toward a moving target and the less of it is
  contribution. The one-way-door risk is not technical; it is that canopy's remaining unique
  value — documents, content search, offline — gets built inside substrat by someone solving
  case 1, and consumer #2 becomes a migration with nothing to contribute.
