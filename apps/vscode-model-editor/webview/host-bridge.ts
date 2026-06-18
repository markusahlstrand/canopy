import type { AiModel, HostBridge, PluginFile } from "@canopy/plugin-sdk";
import type { HostMethod } from "../src/messages";

/**
 * The {@link HostBridge} the model-editor runs against inside the VS Code webview.
 * File and AI capabilities are proxied to the extension host over postMessage
 * (`call`); everything the model-editor never touches (spaces, connectors, mounts,
 * plugin settings) is stubbed so the contract is satisfied.
 */
export function createHostBridge(call: (method: HostMethod, payload: unknown) => Promise<unknown>): HostBridge {
  const unsupported = (name: string): never => {
    throw new Error(`${name} is not available in the VS Code Model Editor`);
  };
  return {
    online: true,
    readFileText: (id) => call("readFileText", { id }) as Promise<string>,
    saveFileVersion: async (id, text) => {
      await call("save", { id, text });
    },
    getFile: (id) => call("getFile", { id }) as Promise<PluginFile | null>,
    listFiles: (dir) => call("listFiles", { dir }) as Promise<PluginFile[]>,
    createFile: (dir, name, content, mime) => call("createFile", { dir, name, content, mime }) as Promise<PluginFile>,
    createAndOpenFile: (input) => call("createAndOpenFile", input) as Promise<PluginFile | null>,
    aiGenerate: (req) => call("aiGenerate", req) as Promise<string>,
    listAiModels: () => call("listAiModels", {}) as Promise<AiModel[]>,

    // Not applicable in the editor-only VS Code host:
    getPluginSettings: async () => null,
    savePluginSettings: async () => {},
    getPluginPlaces: async () => [],
    applySpacePlugin: async () => unsupported("applySpacePlugin"),
    removeSpacePlugin: async () => unsupported("removeSpacePlugin"),
    listSpaces: async () => [],
    syncConnector: async () => ({ ok: false, error: "Connectors are not available in VS Code" }),
    testConnector: async () => ({ ok: false, error: "Connectors are not available in VS Code" }),
    listMount: async () => [],
    readMountText: async () => unsupported("readMountText"),
    mountFileUrl: () => "",
  };
}
