/**
 * Tiered (backup-rotation style) retention for a file's auto-snapshot versions (#11).
 *
 * Over a file's lifetime the version history grows one sealed snapshot per editing
 * bucket, forever. This thins the older tail on a coarsening curve while keeping
 * recent detail:
 *
 *   - **< 24h**   keep everything (full recent detail)
 *   - **24h–7d**  keep one per hour
 *   - **7d–30d**  keep one per day
 *   - **> 30d**   keep one per month (~30-day bucket)
 *
 * Two versions are *always* retained regardless of age: the **current** version and
 * any version a user **pinned** (`keep`). Within a tier the newest version in each
 * bucket survives and the rest are pruned. Audit/compliance is explicitly not a goal,
 * so aggressive thinning of intermediate snapshots is acceptable.
 */

export interface RetainableVersion {
  id: string;
  /** Epoch milliseconds the version was created. */
  createdAtMs: number;
  /** Pinned — never pruned. */
  keep: boolean;
  /** The file's live (current) version — never pruned. */
  isCurrent: boolean;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Given a file's versions and the current time, return the ids that should be
 * pruned under the retention curve. Pure and deterministic — the scheduler and the
 * tests share it.
 */
export function versionsToPrune(versions: RetainableVersion[], nowMs: number): string[] {
  // Newest first, so the first version seen in a bucket is the one we keep.
  const sorted = [...versions].sort((a, b) => b.createdAtMs - a.createdAtMs);
  const seenBucket = new Set<string>();
  const prune: string[] = [];

  for (const v of sorted) {
    if (v.keep || v.isCurrent) continue; // always retained
    const age = nowMs - v.createdAtMs;
    if (age < DAY) continue; // keep all within 24h

    // Tier-prefixed bucket key so an hour bucket can't collide with a day/month one.
    let bucket: string;
    if (age < 7 * DAY) bucket = `h${Math.floor(v.createdAtMs / HOUR)}`;
    else if (age < 30 * DAY) bucket = `d${Math.floor(v.createdAtMs / DAY)}`;
    else bucket = `m${Math.floor(v.createdAtMs / (30 * DAY))}`;

    if (seenBucket.has(bucket)) prune.push(v.id);
    else seenBucket.add(bucket);
  }
  return prune;
}
