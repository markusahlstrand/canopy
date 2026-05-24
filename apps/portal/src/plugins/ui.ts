// Sandboxed UI-slot plugins — the rail-panel / detail-view counterpart to VIEWERS.
//
// First-party plugins that ship trusted React UI stay in PLUGIN_UI (compiled into
// the host). A plugin listed here instead renders inside an opaque-origin iframe
// via <PluginSlot>, exactly as a resolved third-party plugin would. Calendar is
// the reference migration: same look, but no React and no host access beyond the
// capability bridge.
//
// As with viewers, we pull the entry source as raw text and hand it to the sandbox;
// a real third-party plugin arrives the same way, just fetched (zip/github/npm).
import calendarSource from "../../../../examples/plugins/calendar/index.js?raw";

export type SlotName = "detailView" | "railPanel";

export interface SandboxedUIPlugin {
  /** Owning plugin id (matches the manifest id). */
  id: string;
  /** ESM entry source handed to the sandbox; exports one render fn per slot. */
  source: string;
  /** Slots this plugin renders (named exports in `source`). */
  slots: SlotName[];
}

export const UI_PLUGINS: SandboxedUIPlugin[] = [
  { id: "calendar", source: calendarSource, slots: ["detailView", "railPanel"] },
];

/** The sandboxed source for `id`'s `slot`, or undefined if it isn't sandboxed. */
export function sandboxedSlot(id: string, slot: SlotName): { source: string } | undefined {
  const plugin = UI_PLUGINS.find((p) => p.id === id && p.slots.includes(slot));
  return plugin ? { source: plugin.source } : undefined;
}
