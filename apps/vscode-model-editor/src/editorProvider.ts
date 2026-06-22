import * as vscode from "vscode";
import * as path from "node:path";
import { aiGenerate, listAiModels } from "./ai";
import * as files from "./files";
import type { HostMethod, HostToWebview, WebviewToHost } from "./messages";

/**
 * A custom editor that opens `.prisma` / `.tsp` / `.arazzo` / `.asyncapi` files in the Canopy
 * Model Editor webview. The extension host owns the {@link vscode.TextDocument};
 * the webview is the UI and talks to it over postMessage (see ./messages.ts).
 * Saving from the canvas replaces the document text and persists it; external/text
 * edits are pushed back so the canvas re-syncs. File methods (sibling discovery,
 * sidecars, "new document") are served from the workspace filesystem.
 */
export class ModelEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "canopy.modelEditor";

  constructor(private readonly extensionUri: vscode.Uri) {}

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new ModelEditorProvider(context.extensionUri);
    return vscode.window.registerCustomEditorProvider(ModelEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")],
    };
    webview.html = this.getHtml(webview);

    const docPath = document.uri.fsPath;
    // The last text we know both sides agree on. Used to suppress the change echo
    // when a webview-originated save lands back as onDidChangeTextDocument.
    let lastSyncedText = document.getText();

    const post = (msg: HostToWebview) => webview.postMessage(msg);

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      const text = e.document.getText();
      if (text === lastSyncedText) return; // our own save — don't bounce it back
      lastSyncedText = text;
      post({ type: "externalChange" });
    });

    const themeSub = vscode.window.onDidChangeActiveColorTheme(() => post({ type: "theme", dark: isDark() }));

    const msgSub = webview.onDidReceiveMessage(async (msg: WebviewToHost) => {
      if (msg.type === "ready") {
        post({ type: "init", fileName: path.basename(docPath), fsPath: docPath, dir: path.dirname(docPath), dark: isDark() });
        return;
      }
      if (msg.type !== "request") return;
      try {
        const result = await this.dispatch(msg.method, msg.payload, {
          document,
          docPath,
          token,
          setSynced: (t) => {
            lastSyncedText = t;
          },
        });
        post({ type: "response", id: msg.id, ok: true, result });
      } catch (err) {
        post({ type: "response", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });

    panel.onDidDispose(() => {
      changeSub.dispose();
      themeSub.dispose();
      msgSub.dispose();
    });
  }

  private async dispatch(
    method: HostMethod,
    payload: unknown,
    ctx: {
      document: vscode.TextDocument;
      docPath: string;
      token: vscode.CancellationToken;
      setSynced: (text: string) => void;
    },
  ): Promise<unknown> {
    const p = (payload ?? {}) as Record<string, unknown>;
    switch (method) {
      case "readFileText": {
        const id = String(p.id);
        // The open document is the source of truth for its own (possibly unsaved) text.
        return id === ctx.docPath ? ctx.document.getText() : files.readFile(id);
      }
      case "save": {
        const id = String(p.id);
        const text = String(p.text);
        if (id === ctx.docPath) {
          ctx.setSynced(text); // set before the edit so the change echo is suppressed
          await this.replaceDocument(ctx.document, text);
          await ctx.document.save();
        } else {
          await files.writeFile(id, text);
        }
        return null;
      }
      case "getFile":
        return files.getFile(String(p.id));
      case "listFiles":
        return files.listFiles(typeof p.dir === "string" ? p.dir : "");
      case "createFile":
        return files.createFile(String(p.dir), String(p.name), String(p.content));
      case "createAndOpenFile": {
        const dir = path.dirname(ctx.docPath);
        const created = await files.createFile(dir, String(p.name), String(p.content));
        await vscode.commands.executeCommand("vscode.openWith", vscode.Uri.file(created.id), ModelEditorProvider.viewType);
        return created;
      }
      case "aiGenerate":
        return aiGenerate(payload as Parameters<typeof aiGenerate>[0], ctx.token);
      case "listAiModels":
        return listAiModels();
    }
  }

  /** Replace the whole document with `text` via a workspace edit. */
  private async replaceDocument(document: vscode.TextDocument, text: string): Promise<void> {
    if (document.getText() === text) return;
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
    edit.replace(document.uri, fullRange, text);
    await vscode.workspace.applyEdit(edit);
  }

  private getHtml(webview: vscode.Webview): string {
    const asset = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", file));
    const jsUri = asset("webview.js");
    const cssUri = asset("webview.css");
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data: https:`,
      `font-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${cssUri}" />
    <title>Canopy Model Editor</title>
  </head>
  <body>
    <div id="root" style="height: 100vh"></div>
    <script type="module" nonce="${nonce}" src="${jsUri}"></script>
  </body>
</html>`;
  }
}

function isDark(): boolean {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
