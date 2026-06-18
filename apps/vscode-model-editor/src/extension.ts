import * as vscode from "vscode";
import { ModelEditorProvider } from "./editorProvider";
import { createSampleProject } from "./sample";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(ModelEditorProvider.register(context));

  context.subscriptions.push(
    vscode.commands.registerCommand("canopy.modelEditor.createSample", () => createSampleProject()),
  );

  // Escape hatch: reopen the active file in the plain text editor.
  context.subscriptions.push(
    vscode.commands.registerCommand("canopy.modelEditor.openWithText", async () => {
      const uri = vscode.window.activeTextEditor?.document.uri ?? vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      const target =
        uri instanceof vscode.Uri
          ? uri
          : (vscode.window.tabGroups.activeTabGroup.activeTab?.input as { uri?: vscode.Uri } | undefined)?.uri;
      if (target) {
        await vscode.commands.executeCommand("vscode.openWith", target, "default");
      }
    }),
  );
}

export function deactivate(): void {}
