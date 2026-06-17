import {
  aiGenerate,
  applySpacePlugin,
  createFile,
  fetchFileText,
  getFile,
  getPluginPlaces,
  getPluginSettings,
  listAiModels,
  listFiles,
  listMount,
  listSpaces,
  mountFileUrl,
  readText,
  removeSpacePlugin,
  savePluginSettings,
  saveFileVersion,
  syncConnector,
  testConnector,
} from "@/lib/api";
import type { HostBridge } from "@canopy/plugin-sdk";
import type { HostApi } from "@/plugins/host";

/**
 * Build the SDK {@link HostBridge} from the app's API client and the imperative
 * {@link HostApi}. This is the single seam where app internals (`@/lib/api`, host
 * actions) are wired to the plugin capability contract — trusted plugins call the
 * bridge via `usePluginHost()` and never import `@/lib/api` themselves. To host the
 * same plugins elsewhere (e.g. a VS Code webview), reimplement this one function.
 */
export function createHostBridge(host: HostApi): HostBridge {
  return {
    get online() {
      return host.online;
    },
    readFileText: (id) => fetchFileText(id),
    saveFileVersion: (id, text, mime) => saveFileVersion(id, text, mime),
    createFile: (dir, name, content, mime, spaceId) => createFile(dir, name, content, mime, spaceId),
    getFile: (id) => getFile(id),
    listFiles: (dir, spaceId) => listFiles(dir, spaceId),
    createAndOpenFile: (input) => host.createAndOpenFile(input),
    aiGenerate: (req) => aiGenerate(req),
    listAiModels: () => listAiModels(),
    getPluginSettings: (pluginId) => getPluginSettings(pluginId),
    savePluginSettings: (pluginId, values) => savePluginSettings(pluginId, values),
    getPluginPlaces: (pluginId) => getPluginPlaces(pluginId),
    applySpacePlugin: (spaceId, pluginId) => applySpacePlugin(spaceId, pluginId),
    removeSpacePlugin: (spaceId, pluginId) => removeSpacePlugin(spaceId, pluginId),
    listSpaces: () => listSpaces(),
    syncConnector: (pluginId) => syncConnector(pluginId),
    testConnector: (pluginId) => testConnector(pluginId),
    listMount: (path, mount) => listMount(path, mount),
    readMountText: (path, mount) => readText(path, mount),
    mountFileUrl: (path, mount) => mountFileUrl(path, mount),
  };
}
