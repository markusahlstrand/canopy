import type { PluginManifest } from "./plugin";
import type { ContextMenuContribution, RailPanelContribution } from "./contributions";

export interface RegisteredPlugin {
  manifest: PluginManifest;
}

export interface ContextMenuEntry {
  pluginId: string;
  item: ContextMenuContribution;
}

export interface RailPanelEntry {
  pluginId: string;
  panel: RailPanelContribution;
  manifest: PluginManifest;
}

/**
 * In-memory registry of installed plugins. The host queries it to drive the
 * rail, context menus, store, and detail views — so first-party plugins like
 * Calendar and Tasks render through the same path as third-party ones.
 */
export class PluginRegistry {
  #plugins = new Map<string, RegisteredPlugin>();

  register(manifest: PluginManifest): void {
    this.#plugins.set(manifest.id, { manifest });
  }

  unregister(id: string): void {
    this.#plugins.delete(id);
  }

  get(id: string): RegisteredPlugin | undefined {
    return this.#plugins.get(id);
  }

  has(id: string): boolean {
    return this.#plugins.has(id);
  }

  list(): RegisteredPlugin[] {
    return [...this.#plugins.values()];
  }

  railPanels(): RailPanelEntry[] {
    const out: RailPanelEntry[] = [];
    for (const { manifest } of this.list()) {
      const panel = manifest.contributes?.railPanel;
      if (panel) out.push({ pluginId: manifest.id, panel, manifest });
    }
    return out;
  }

  contextMenuItems(kind: string): ContextMenuEntry[] {
    const out: ContextMenuEntry[] = [];
    for (const { manifest } of this.list()) {
      for (const item of manifest.contributes?.contextMenu ?? []) {
        if (!item.when?.kinds || item.when.kinds.includes(kind)) {
          out.push({ pluginId: manifest.id, item });
        }
      }
    }
    return out;
  }
}
