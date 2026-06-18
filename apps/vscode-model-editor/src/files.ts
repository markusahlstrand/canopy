import * as vscode from "vscode";
import * as path from "node:path";
import type { PluginFile } from "@canopy/plugin-sdk";

/**
 * Maps the model-editor's file capabilities onto the workspace filesystem. The
 * plugin treats files by opaque "id" and folders by "dir"; in VS Code both are
 * just filesystem paths (`Uri.fsPath`). The spec editor uses these to discover
 * sibling `.tsp`/`.arazzo`/`.json` files and to write its sidecar — so backing
 * them with `vscode.workspace.fs` makes cross-layer linking work for real.
 */

const td = new TextDecoder();
const te = new TextEncoder();

function toPluginFile(fsPath: string, isDir: boolean): PluginFile {
  return { id: fsPath, name: path.basename(fsPath), path: path.dirname(fsPath), kind: isDir ? "folder" : undefined };
}

export async function readFile(fsPath: string): Promise<string> {
  return td.decode(await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath)));
}

export async function writeFile(fsPath: string, content: string): Promise<void> {
  await vscode.workspace.fs.writeFile(vscode.Uri.file(fsPath), te.encode(content));
}

export async function getFile(fsPath: string): Promise<PluginFile | null> {
  try {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
    return toPluginFile(fsPath, stat.type === vscode.FileType.Directory);
  } catch {
    return null;
  }
}

export async function listFiles(dir: string): Promise<PluginFile[]> {
  if (!dir) return [];
  try {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    return entries.map(([name, type]) => toPluginFile(path.join(dir, name), type === vscode.FileType.Directory));
  } catch {
    return [];
  }
}

export async function createFile(dir: string, name: string, content: string): Promise<PluginFile> {
  const fsPath = path.join(dir, name);
  await writeFile(fsPath, content);
  return toPluginFile(fsPath, false);
}
