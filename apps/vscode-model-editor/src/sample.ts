import * as vscode from "vscode";
import * as path from "node:path";
import { SAMPLE_PROJECT, SAMPLE_ENTRYPOINT } from "@canopy/model-editor";
import { writeFile } from "./files";
import { ModelEditorProvider } from "./editorProvider";

/**
 * The shared "Pet Store" starter project (see {@link SAMPLE_PROJECT}) plus a
 * VS Code-specific README. One contract (`main.tsp`) projected across the spec
 * workspace, with an `openapi.yaml` the workflow resolves to, two Arazzo workflows,
 * and an AsyncAPI document whose channels link back to the entities and endpoints —
 * everything cross-links by id, so the sample doubles as a tour of find-usages.
 */
const README = `# Canopy Model Editor — Pet Store sample

A coherent Pet Store across every editor. Open **main.tsp** and use the tabs
(Entities · Endpoints · Events · Flows · Source) — clicking any item highlights
what references it in the other layers.

- **schema.prisma** — a Prisma data model (\`Owner\` → \`Pet\` → \`Visit\`). Drag
  entities, draw relations, and export to SQL / JSON Schema / Mermaid.
- **main.tsp** — the TypeSpec contract: \`Owner\`, \`Pet\` and \`Visit\` entities plus
  CRUD operations grouped under the \`owners\`, \`pets\` and \`visits\` tags.
- **openapi.yaml** — the OpenAPI the contract emits; the workflow's
  \`sourceDescriptions\` resolve to it.
- **workflow.arazzo.yaml** — two Arazzo workflows (\`onboardCustomer\`,
  \`findAndBook\`) whose steps call the operations above; \`x-typespec-source\` links
  them back to \`main.tsp\` so the editor can trace steps → endpoints → entities.
- **events.asyncapi.yaml** — AsyncAPI channels whose message payloads link to the
  \`Pet\` and \`Visit\` entities, bound to the \`getPet\` / \`bookVisit\` endpoints —
  surfaced in the **Events** tab.

To see the raw text of any file, right-click the tab →
**Reopen Editor With… → Text Editor**.
`;

const SAMPLE_FILES: { name: string; content: string }[] = [
  ...SAMPLE_PROJECT,
  { name: "README.md", content: README },
];

/** Where to drop the sample, asking the user when it's ambiguous. */
async function chooseBaseDir(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
    return folder ? path.join(folder.uri.fsPath, "petstore-sample") : undefined;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: "Create sample here",
    title: "Choose a folder for the Canopy sample project",
  });
  return picked?.[0] ? path.join(picked[0].fsPath, "petstore-sample") : undefined;
}

async function exists(fsPath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
    return true;
  } catch {
    return false;
  }
}

export async function createSampleProject(): Promise<void> {
  const baseDir = await chooseBaseDir();
  if (!baseDir) return;

  if (await exists(path.join(baseDir, "schema.prisma"))) {
    const choice = await vscode.window.showWarningMessage(
      `A sample already exists in ${baseDir}. Overwrite it?`,
      { modal: true },
      "Overwrite",
    );
    if (choice !== "Overwrite") return;
  }

  await Promise.all(SAMPLE_FILES.map((f) => writeFile(path.join(baseDir, f.name), f.content)));

  // Open the contract in the spec workspace so the user lands on the cross-linked
  // Entities · Endpoints · Events · Flows tabs straight away.
  await vscode.commands.executeCommand(
    "vscode.openWith",
    vscode.Uri.file(path.join(baseDir, "main.tsp")),
    ModelEditorProvider.viewType,
  );
  vscode.window.showInformationMessage(`Pet Store sample project created in ${baseDir}.`);
}
