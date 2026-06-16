import { describe, expect, it } from "vitest";
import { versionsToPrune, type RetainableVersion } from "./retention";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 4, 24, 12, 0, 0); // fixed "now"

/** Build a version `ageMs` before NOW. */
function v(id: string, ageMs: number, extra: Partial<RetainableVersion> = {}): RetainableVersion {
  return { id, createdAtMs: NOW - ageMs, keep: false, isCurrent: false, ...extra };
}

describe("versionsToPrune — tiered retention curve", () => {
  it("keeps everything younger than 24h", () => {
    const versions = [v("a", 1 * HOUR), v("b", 5 * HOUR), v("c", 23 * HOUR)];
    expect(versionsToPrune(versions, NOW)).toEqual([]);
  });

  it("thins the 24h–7d tier to one per hour", () => {
    // Three versions inside one hour bucket (~2 days old) → keep newest, prune 2.
    // NOW is on the hour, so (NOW - 49h) is the start of a bucket; minute offsets
    // inside it stay in the same bucket.
    const hourStart = 49 * HOUR; // age of the bucket start
    const versions = [v("newest", hourStart - 50 * 60_000), v("mid", hourStart - 30 * 60_000), v("oldest", hourStart - 10 * 60_000)];
    expect(versionsToPrune(versions, NOW).sort()).toEqual(["mid", "oldest"]);
  });

  it("keeps versions in distinct hour buckets within the 24h–7d tier", () => {
    const versions = [v("h1", 2 * DAY), v("h2", 2 * DAY + 1 * HOUR), v("h3", 2 * DAY + 2 * HOUR)];
    expect(versionsToPrune(versions, NOW)).toEqual([]);
  });

  it("thins the 7d–30d tier to one per day", () => {
    const base = 10 * DAY;
    const versions = [v("d-new", base), v("d-old", base + 3 * HOUR)]; // same calendar day bucket
    expect(versionsToPrune(versions, NOW)).toEqual(["d-old"]);
  });

  it("thins the >30d tier to one per ~month", () => {
    const base = 40 * DAY;
    const versions = [v("m-new", base), v("m-old", base + 5 * DAY)]; // same 30-day bucket
    expect(versionsToPrune(versions, NOW)).toEqual(["m-old"]);
  });

  it("never prunes pinned or current versions even when their bucket is full", () => {
    const base = 2 * DAY; // one hour bucket
    const versions = [
      v("kept", base, { keep: true }),
      v("current", base + 60_000, { isCurrent: true }),
      v("survivor", base + 120_000), // first non-pinned/non-current in the bucket → kept
      v("doomed", base + 180_000), // same bucket, older → pruned
    ];
    expect(versionsToPrune(versions, NOW)).toEqual(["doomed"]);
  });
});

describe("versionsToPrune — explicit policies", () => {
  it("'all' prunes nothing, even an old crowded bucket", () => {
    const base = 40 * DAY;
    const versions = [v("a", base), v("b", base + DAY), v("c", base + 2 * DAY)];
    expect(versionsToPrune(versions, NOW, { policy: "all" })).toEqual([]);
  });

  it("'days' prunes everything older than the window, keeps the rest", () => {
    const versions = [v("recent", 2 * DAY), v("edge", 6 * DAY), v("old", 9 * DAY)];
    // 7-day window → only the 9-day-old version falls outside.
    expect(versionsToPrune(versions, NOW, { policy: "days", days: 7 })).toEqual(["old"]);
  });

  it("'days' still spares pinned + current versions outside the window", () => {
    const versions = [
      v("pinned-old", 30 * DAY, { keep: true }),
      v("current-old", 31 * DAY, { isCurrent: true }),
      v("plain-old", 32 * DAY),
    ];
    expect(versionsToPrune(versions, NOW, { policy: "days", days: 7 })).toEqual(["plain-old"]);
  });

  it("'days' with a non-positive window falls back to the smart curve", () => {
    const base = 10 * DAY;
    const versions = [v("d-new", base), v("d-old", base + 3 * HOUR)]; // same day bucket
    // days: 0 is invalid → behaves like the default tiered prune.
    expect(versionsToPrune(versions, NOW, { policy: "days", days: 0 })).toEqual(["d-old"]);
  });

  it("explicit 'smart' matches the default", () => {
    const base = 10 * DAY;
    const versions = [v("d-new", base), v("d-old", base + 3 * HOUR)];
    expect(versionsToPrune(versions, NOW, { policy: "smart" })).toEqual(versionsToPrune(versions, NOW));
  });
});
