import type { Db } from "./db";

/**
 * The set of plugins a user has installed, persisted as one JSON array per user.
 * Returning `null` (no row) lets the caller apply its auth-dependent defaults,
 * which stays distinct from a stored empty list (everything uninstalled).
 */
export async function getInstalledPlugins(db: Db, userSub: string): Promise<string[] | null> {
  const row = await db.first<{ plugin_ids: string }>(
    "SELECT plugin_ids FROM plugin_installs WHERE user_sub = ?",
    [userSub],
  );
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.plugin_ids);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export async function setInstalledPlugins(db: Db, userSub: string, pluginIds: string[]): Promise<void> {
  await db.run(
    "INSERT INTO plugin_installs (user_sub, plugin_ids, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(user_sub) DO UPDATE SET plugin_ids = excluded.plugin_ids, updated_at = excluded.updated_at",
    [userSub, JSON.stringify(pluginIds), new Date().toISOString()],
  );
}
