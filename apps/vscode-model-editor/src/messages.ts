// The postMessage protocol between the extension host and the webview. Kept in
// one place so both sides stay in sync.

/** HostBridge methods the webview proxies to the extension host. */
export type HostMethod =
  | "readFileText"
  | "save"
  | "getFile"
  | "listFiles"
  | "createFile"
  | "createAndOpenFile"
  | "aiGenerate"
  | "listAiModels";

/** Extension host → webview. */
export type HostToWebview =
  /** First payload: the opened file's identity (paths are filesystem paths) + theme. */
  | { type: "init"; fileName: string; fsPath: string; dir: string; dark: boolean }
  /** The document changed outside the webview — a signal to reload the canvas. */
  | { type: "externalChange" }
  /** The color theme flipped. */
  | { type: "theme"; dark: boolean }
  /** Reply to a webview `request` (correlated by id). */
  | { type: "response"; id: number; ok: true; result: unknown }
  | { type: "response"; id: number; ok: false; error: string };

/** Webview → extension host. */
export type WebviewToHost =
  /** The webview has mounted and is ready to receive `init`. */
  | { type: "ready" }
  /** A HostBridge call awaiting a `response` (correlated by id). */
  | { type: "request"; id: number; method: HostMethod; payload: unknown };
