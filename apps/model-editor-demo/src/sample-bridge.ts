import type { HostBridge, PluginFile } from "@canopy/plugin-sdk";
import { SAMPLE_PROJECT } from "@canopy/model-editor";

/**
 * An in-memory {@link HostBridge} over the shared Pet Store sample
 * ({@link SAMPLE_PROJECT}) — lets the demo run the full spec workspace (entities,
 * endpoints, channels, flows) with no local folder. All files live in the root, so
 * file ids are just their names. Edits are kept in memory and lost on reload.
 */
export function createSampleBridge(): HostBridge {
  // Working copy so edits from the canvas round-trip within the session.
  const text = new Map<string, string>(SAMPLE_PROJECT.map((f) => [f.name, f.content]));
  const asFile = (name: string): PluginFile => ({ id: name, name, path: "" });
  const noop = async () => {};
  return {
    online: true,
    readFileText: async (id) => {
      const cur = text.get(id);
      if (cur === undefined) throw new Error(`No such file: ${id}`);
      return cur;
    },
    saveFileVersion: async (id, next) => {
      if (!text.has(id)) throw new Error(`No such file: ${id}`);
      text.set(id, next);
    },
    getFile: async (id) => (text.has(id) ? asFile(id) : null),
    listFiles: async () => [...text.keys()].map(asFile),
    createFile: async (_dir, name, content) => {
      text.set(name, content ?? "");
      return asFile(name);
    },
    createAndOpenFile: async () => null,
    aiGenerate: async () => {
      throw new Error("AI is not available in the sample");
    },
    listAiModels: async () => [],
    getPluginSettings: async () => null,
    savePluginSettings: noop,
    getPluginPlaces: async () => [],
    applySpacePlugin: noop,
    removeSpacePlugin: noop,
    listSpaces: async () => [],
    syncConnector: async () => ({ ok: false }),
    testConnector: async () => ({ ok: false }),
    listMount: async () => [],
    readMountText: async () => "",
    mountFileUrl: () => "",
  };
}
