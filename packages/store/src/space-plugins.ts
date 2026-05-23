import type { Db } from "./db";

/**
 * The per-space plugin layer. A plugin "applied" to a space is active for every
 * member of that space (see {@link FileService} for the owner-only write guard and
 * the union with per-user installs). The `config` JSON of a plugin stays per-user
 * (see plugin-settings.ts); this table records only *which* plugins a place runs.
 */

/** Plugin ids applied to a space, in apply order. */
export async function getSpacePlugins(db: Db, spaceId: string): Promise<string[]> {
  const rows = await db.all<{ plugin_id: string }>(
    "SELECT plugin_id FROM space_plugins WHERE space_id = ? ORDER BY applied_at",
    [spaceId],
  );
  return rows.map((r) => r.plugin_id);
}

/** Apply a plugin to a space (idempotent). */
export async function applySpacePlugin(db: Db, spaceId: string, pluginId: string, appliedBy: string): Promise<void> {
  await db.run(
    "INSERT OR IGNORE INTO space_plugins (space_id, plugin_id, applied_by, applied_at) VALUES (?, ?, ?, ?)",
    [spaceId, pluginId, appliedBy, new Date().toISOString()],
  );
}

/** Remove a plugin from a space. */
export async function removeSpacePlugin(db: Db, spaceId: string, pluginId: string): Promise<void> {
  await db.run("DELETE FROM space_plugins WHERE space_id = ? AND plugin_id = ?", [spaceId, pluginId]);
}

/** Distinct plugin ids applied to any of the given spaces (the caller's memberships). */
export async function pluginIdsForSpaces(db: Db, spaceIds: string[]): Promise<string[]> {
  if (spaceIds.length === 0) return [];
  const rows = await db.all<{ plugin_id: string }>(
    `SELECT DISTINCT plugin_id FROM space_plugins WHERE space_id IN (${spaceIds.map(() => "?").join(",")})`,
    spaceIds,
  );
  return rows.map((r) => r.plugin_id);
}

/** Of `spaceIds`, the subset a given plugin is applied to (for the per-plugin "Applies to" UI). */
export async function spacesWithPlugin(db: Db, pluginId: string, spaceIds: string[]): Promise<Set<string>> {
  if (spaceIds.length === 0) return new Set();
  const rows = await db.all<{ space_id: string }>(
    `SELECT space_id FROM space_plugins WHERE plugin_id = ? AND space_id IN (${spaceIds.map(() => "?").join(",")})`,
    [pluginId, ...spaceIds],
  );
  return new Set(rows.map((r) => r.space_id));
}
