/**
 * The kernel contract, run in CANOPY's CI — a bump gate, not a canopy test (#44).
 *
 * Read the ownership before reading the code, because it is the opposite of the
 * suite next door. `conformance.test.ts` drives canopy's own operations against
 * canopy's own handlers: a failure there is canopy's bug. THESE suites drive
 * substrat's test modules against substrat's adapter. A failure here is almost
 * certainly SUBSTRAT's bug — and the reason to run them anyway is that canopy
 * would otherwise find out about it in production.
 *
 * Canopy owns no adapter. S5 is dead: `@substrat-run/adapter-cloudflare` was
 * built without canopy, and canopy consumes it rather than maintaining
 * `db-d1.ts` / `blob-r2.ts`. What canopy does own is a VERSION RANGE, and a
 * pre-1.0 kernel moves fast — 0.114 → 0.116 landed in a day. These suites are
 * how a bump proves itself before it reaches canopy's users. When one goes red,
 * the first question is "what did the kernel change?", not "what did we break?".
 *
 * WHAT THIS DOES NOT COVER, said plainly because a gate that overclaims is worse
 * than no gate: canopy runs `CloudflareScopeHost` in production, and these run
 * against `SqliteScopeHost`, because the Cloudflare adapter needs workerd and
 * this is a node test run. D-14 is what makes the substitution meaningful — both
 * adapters pass the same suites, forever — but it is a proxy, not the real thing.
 * A fault that lives only in the DO implementation will not appear here.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UNSAFE_allowAllChecker, webCryptoSecretBox } from '@substrat-run/kernel';
import {
  connectorTestFetch,
  jobRunContractSuite,
  permissionContractSuite,
  scopeHostContractSuite,
  searchContractSuite,
} from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';

/** A fixed key: the suites assert a credential round-trips, not that it is unpredictable. */
const secretBox = () => webCryptoSecretBox('test-key', new Uint8Array(32).fill(7));

const store = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), `canopy-${prefix}-`));
  return {
    dir,
    cleanup: async (host: SqliteScopeHost) => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

scopeHostContractSuite('adapter-sqlite (as canopy consumes it)', async () => {
  const { dir, cleanup } = store('scope-host');
  const host = new SqliteScopeHost({
    dir,
    checker: UNSAFE_allowAllChecker,
    secretBox: secretBox(),
    fetch: connectorTestFetch,
  });
  return { host, cleanup: () => cleanup(host) };
});

// The tuple engine itself — the DEFAULT checker, never allow-all. This is the one
// that matters most to canopy: the drive replaced `authz.ts` and the `pathRole`
// ancestor walk with grants that travel down a declared parent edge, and this suite
// is what says that edge still means what it meant at the version canopy pinned.
permissionContractSuite('adapter-sqlite (as canopy consumes it)', async () => {
  const { dir, cleanup } = store('permission');
  const host = new SqliteScopeHost({ dir, secretBox: secretBox() });
  return { host, cleanup: () => cleanup(host) };
});

// The derived FTS index the drive's `searchables` feed. Allow-all: the subject is
// what the index answers, and the gate over a search operation is the vertical's own.
// S9b (#56) extends this half from filenames to extracted content, so the contract
// under it is about to start carrying weight it does not carry today.
searchContractSuite('adapter-sqlite (as canopy consumes it)', async () => {
  const { dir, cleanup } = store('search');
  const host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
  return { host, cleanup: () => cleanup(host) };
});

/**
 * The resumable-run driver (#1577), which canopy does not use YET.
 *
 * Mounted ahead of its consumer on purpose. It is the driver S9b's extraction
 * needs — one in-flight run per source, resumable from a cursor, surviving an
 * eviction — and it is the single reason canopy moved off 0.114. Pinning it now
 * means the day an extraction job is written the contract beneath it is already
 * held; the alternative is discovering a driver change and an extraction bug in
 * the same red build. The DEFAULT checker: a job's steps act through the system
 * door, and what they may do has to resolve through the real tuple engine.
 */
jobRunContractSuite('adapter-sqlite (as canopy consumes it)', async () => {
  const { dir, cleanup } = store('job-run');
  const host = new SqliteScopeHost({ dir, secretBox: secretBox() });
  return { host, cleanup: () => cleanup(host) };
});
