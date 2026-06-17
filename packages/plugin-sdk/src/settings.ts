/**
 * The plugin-settings contract — a plugin declares config fields server-side and the
 * host renders them with {@link PluginSettingsDialog}. Part of the SDK because it's a
 * generic plugin concept, not one feature's shape. `@/lib/api` re-exports these.
 */

export interface PluginConfigField {
  key: string;
  label: string;
  type: "string" | "secret" | "url" | "boolean" | "select";
  required?: boolean;
  /** Choices for a "select" field (for AI-model fields, filled by the server). */
  options?: { value: string; label: string }[];
  /** Show this field only when `field` currently holds one of these values. */
  showWhen?: { field: string; in: string[] };
}

export interface PluginSettings {
  fields: PluginConfigField[];
  /** Current non-secret values. */
  values: Record<string, string>;
  /** Keys of secret fields that have a stored value (the value itself is never sent). */
  secretsSet: string[];
}

/** A group space the caller owns, flagged with whether a plugin is applied there. */
export interface PluginPlace {
  spaceId: string;
  name: string;
  applied: boolean;
}
