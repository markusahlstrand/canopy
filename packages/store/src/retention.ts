import type { VersionPolicyKind } from "./types";

/**
 * Retention for a file's auto-snapshot versions (#11). A space chooses one of three
 * policies (see {@link VersionPolicyKind}); the default `"smart"` is the tiered
 * (backup-rotation style) curve:
 *
 *   - **< 24h**   keep everything (full recent detail)
 *   - **24h–7d**  keep one per hour
 *   - **7d–30d**  keep one per day
 *   - **> 30d**   keep one per month (~30-day bucket)
 *
 * `"all"` keeps every version; `"days"` keeps only those created within the last N
 * days. Two versions are *always* retained regardless of age or policy: the
 * **current** version and any version a user **pinned** (`keep`). Audit/compliance is
 * explicitly not a goal, so aggressive thinning of intermediate snapshots is fine.
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

/** A space's resolved retention policy — the shape `getVersionPolicy` returns. */
export interface RetentionPolicy {
  policy: VersionPolicyKind;
  /** Day window for the `"days"` policy; ignored otherwise. */
  days?: number | null;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const SMART: RetentionPolicy = { policy: "smart" };

/**
 * Given a file's versions and the current time, return the ids that should be pruned
 * under the space's retention {@link RetentionPolicy} (defaults to the `"smart"`
 * curve). Pure and deterministic — the scheduler and the tests share it.
 */
export function versionsToPrune(
  versions: RetainableVersion[],
  nowMs: number,
  policy: RetentionPolicy = SMART,
): string[] {
  if (policy.policy === "all") return []; // keep every version
  // Newest first, so the first version seen in a bucket is the one we keep.
  const sorted = [...versions].sort((a, b) => b.createdAtMs - a.createdAtMs);
  const seenBucket = new Set<string>();
  const prune: string[] = [];

  // A positive `days` window switches to "keep the last N days"; anything else (null,
  // 0, NaN) falls back to the smart curve so a misconfigured space never over-prunes.
  const dayWindow =
    policy.policy === "days" && typeof policy.days === "number" && policy.days > 0 ? policy.days * DAY : null;

  for (const v of sorted) {
    if (v.keep || v.isCurrent) continue; // always retained
    const age = nowMs - v.createdAtMs;

    if (dayWindow !== null) {
      if (age > dayWindow) prune.push(v.id); // keep all within the window, drop the rest
      continue;
    }

    if (age < DAY) continue; // smart: keep all within 24h

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
