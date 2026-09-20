# The jobs rail, against what the platform now ships

*S2 of the convergence rail ([#43](https://github.com/markusahlstrand/canopy/issues/43)),
written 2026-09-20 against `@substrat-run/kernel` on `main`.*

The ticket asked for a gap statement rather than a port: which of canopy's jobs needs
are already served, and which are genuinely missing. The answer changed while the ticket
was open. On the day it was filed the platform had three ways to move work off a request
— event executors with retry, declared schedules, a platform sweep — and none of them
covered a long, resumable walk. That gap was filed upstream in the platform's own terms,
the platform built it, and **it is now shipped**: a job-run driver in the kernel, in both
adapters, pinned by one shared conformance suite.

So this document is shorter than the ticket expected, and its conclusion is blunter.

## 1. The verdict

**Canopy's jobs port is now a second implementation of a platform contract.** Not an
approximation of one — the same contract, down to the coalescing key's shape and the
rule about what may ride in a payload. The rail's remaining work is convergence, and
one ticket on it is dead.

## 2. Side by side

| | `@canopy/store` (`jobs.ts`, `runs.ts`) | `@substrat-run/kernel` (`job-run.ts`) |
|---|---|---|
| Coalescing key | `pluginId:name:instanceKey` | `JobRunKey { moduleId, job, instance }` — one LIVE run per triple |
| Joining an in-flight run | adapter-enforced, never a table constraint | driver decision, never a table constraint — *for the same stated reason*: a run whose worker vanished must stay restartable |
| Payload rule | `assertJobPayload` — ids and config; bytes, class instances, functions refused with the offending path | `assertQueueSafe` — same rule, same refusal, names the exact field |
| Resume | `cursor` + `setCursor`, carried forward on an unadvanced run | `JobPassResult.cursor`, omitted keeps the last committed one |
| Steps | `step(name, fn, opts)` with per-step retry | `step(name, fn, retry?)` with `ExecutorRetryPolicy`, **memoised** — a committed step is not re-run |
| Determinism rule | step names a pure function of payload + prior results | same, and *enforced*: two calls under one name in one pass are refused |
| Run record | `runs.ts` — status, cursor, counter bag | `JobRun` — status, payload, cursor, counters, attempts, lastError, `nextAttemptAt`, timestamps |
| Adapters | in-process; a CF Workflow dispatcher (T3, never built) | SQLite + Durable Objects, both shipped |
| Tests | canopy's own | one conformance suite run against both adapters |

The overlap is not a coincidence. Both were designed against the same problem — an
hour-long crawl over a source that must survive an eviction — and the upstream issue that
produced this driver was written from canopy's experience of it.

## 3. What the platform has that canopy does not

Worth naming, because these are the reasons to adopt rather than keep:

- **Steps are memoised.** Canopy re-runs a step on a later failure; the kernel returns
  the committed result without running `fn`. It also documents the trade honestly —
  at-least-once, ledger row after the effect, so a step body must be idempotent.
- **An operator read.** `jobRuns` with a filter, and a `decodeError` that makes one
  unreadable row visible instead of taking the whole list down with it.
- **Attribution.** A pass reaches its scope through the system door, so a job's writes
  are `{ system: moduleId }` and gated by an ordinary check against `system:<moduleId>`
  grants — rather than running as whoever happened to trigger it.
- **`attempts` / `nextAttemptAt`** on the record, so backoff is inspectable rather than
  inferred.

## 4. What canopy has that the platform does not

One thing, and it is small: **the live progress line.** `JobContext.log(message, level)`
pushes best-effort progress to a channel so a user watching an index run sees it move.
The kernel has counters committed with each pass, which is the durable half of the same
need, and no live half.

That is the whole list. It is not obviously worth proposing upstream — counters plus the
run record may cover what the UI actually needs, and a live line is a transport concern
more than a job-contract one. **Decide when the drive's indexing needs it**, not now.

Canopy's *plugin* layer is not a gap either. `JobDefinition`, the `jobs` capability and
manifest block, and `jobsOf` (#54) describe how a **plugin** offers work — which the
platform has no opinion about, because its unit is a module in a vertical. That layer
stays canopy's, and converges by becoming thin: a `JobDefinition` handler becomes a
`JobHandler` pass, and the cron in the manifest becomes a declared `ScheduleSpec`.

## 5. The rail, re-scoped

| Ticket | Was | Now |
|---|---|---|
| T1 runs table | shipped | superseded by `JobRun`; the table goes when the port does |
| T2 jobs port + in-process adapter | shipped | becomes an adapter over the kernel driver, or is deleted |
| **T3 CF Workflow dispatcher** | next up | **dead — do not build.** The platform ships a Durable-Object driver for this, conformance-tested |
| T4 plugin jobs role | shipped (#54) | stays; becomes thin (handler → pass, cron → `ScheduleSpec`) |
| T5 host cron tick | planned | dead — declared schedules plus the platform sweep already own the timer |
| T6–T12 sync flows | planned | unchanged in intent; they are consumers, and they get a driver instead of building one |
| T13 jobs dashboard | planned | narrows to a canopy view over `jobRuns`, if the platform's own dashboard does not already answer it |

## 6. What follows

Nothing on this rail should be built until its consumer exists. The first real consumer is
the drive's indexing — content extraction ([#56](https://github.com/markusahlstrand/canopy/issues/56)),
which is a walk over a scope's uploads and is exactly the shape this driver is for. So the
order is: bytes ([#55](https://github.com/markusahlstrand/canopy/issues/55)), then
extraction as the first job written against the kernel driver, and canopy's own port is
retired behind it rather than ahead of it.

*Acceptance for [#43](https://github.com/markusahlstrand/canopy/issues/43): every canopy
jobs need above either maps to a shipped kernel driver or is named as a proposed addition
with the consumer that needs it. One item is proposed and deferred (the live progress
line); everything else maps.*
