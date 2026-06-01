import type { TextWindow } from "./types";

/**
 * Slice `[offset, offset+limit)` out of a full text and report the true `total`
 * so a caller can page deterministically. Clamps a negative/oversized offset to
 * `[0, total]`; an omitted `limit` returns through the end. `truncated` is true
 * exactly when the slice stops before `total` — the signal that there's more.
 */
export function windowText(full: string, opts?: TextWindow): { text: string; total: number; truncated: boolean } {
  const total = full.length;
  const start = Math.min(Math.max(opts?.offset ?? 0, 0), total);
  const end = opts?.limit != null ? start + Math.max(opts.limit, 0) : total;
  const text = full.slice(start, end);
  return { text, total, truncated: start + text.length < total };
}
