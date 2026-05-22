import type { Db } from "./db";

/**
 * Per-user, per-plugin settings (e.g. the GitHub source's repo + encrypted
 * token). The value is an **opaque JSON string** as far as the store is
 * concerned — the API layer is responsible for encrypting any secret fields
 * before saving and decrypting them on read. The store never inspects it.
 */
export async function getPluginSettings(db: Db, userSub: string, pluginId: string): Promise<string | null> {
  const row = await db.first<{ config: string }>(
    "SELECT config FROM plugin_settings WHERE user_sub = ? AND plugin_id = ?",
    [userSub, pluginId],
  );
  return row?.config ?? null;
}

export async function setPluginSettings(db: Db, userSub: string, pluginId: string, config: string): Promise<void> {
  await db.run(
    "INSERT INTO plugin_settings (user_sub, plugin_id, config, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(user_sub, plugin_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at",
    [userSub, pluginId, config, new Date().toISOString()],
  );
}

export async function deletePluginSettings(db: Db, userSub: string, pluginId: string): Promise<void> {
  await db.run("DELETE FROM plugin_settings WHERE user_sub = ? AND plugin_id = ?", [userSub, pluginId]);
}
