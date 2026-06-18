import * as vscode from "vscode";
import * as path from "node:path";
import { writeFile } from "./files";
import { ModelEditorProvider } from "./editorProvider";

/**
 * A small, coherent starter project that shows off all three editors at once,
 * built around the Pet Store — the canonical API example. A Prisma schema (with a
 * relation), a TypeSpec API, and an Arazzo workflow that links back to the API via
 * `x-typespec-source` + matching operation ids. The contents mirror the
 * model-editor's own creator templates, so they're guaranteed to parse.
 */
const SAMPLE_FILES: { name: string; content: string }[] = [
  {
    name: "schema.prisma",
    content: `// Sample Prisma schema — open in the Canopy Model Editor to edit it visually.
// Drag entities, draw relations, then export to SQL / JSON Schema / Mermaid.

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model Owner {
  id        String   @id @default(cuid())
  name      String
  email     String   @unique
  pets      Pet[]
  createdAt DateTime @default(now())
}

model Pet {
  id        String   @id @default(cuid())
  name      String
  status    String   @default("available")
  owner     Owner?   @relation(fields: [ownerId], references: [id])
  ownerId   String?
  createdAt DateTime @default(now())
}
`,
  },
  {
    name: "main.tsp",
    content: `import "@typespec/http";

using TypeSpec.Http;

@service(#{ title: "Pet Store" })
namespace PetStore;

model Pet {
  @key id: string;
  name: string;
  status: string;
}

@route("/pets")
interface Pets {
  @get
  @operationId("listPets")
  list(): Pet[];

  @get
  @operationId("getPet")
  read(@path id: string): Pet;
}
`,
  },
  {
    name: "workflow.arazzo.yaml",
    content: `arazzo: 1.0.1
info:
  title: Find a pet
  version: 1.0.0
# x-typespec-source links this workflow back to the TypeSpec contract so the editor
# can trace steps -> endpoints -> entities across the .tsp and .arazzo files.
x-typespec-source: ./main.tsp
sourceDescriptions:
  - name: api
    url: ./openapi.yaml
    type: openapi
workflows:
  - workflowId: findPet
    summary: List pets, then fetch the first one.
    steps:
      - stepId: listPets
        description: Get all pets.
        operationId: listPets
        successCriteria:
          - condition: $statusCode == 200
        outputs:
          pets: $response.body
      - stepId: getPet
        description: Fetch a single pet by id.
        operationId: getPet
        parameters:
          - name: id
            in: path
            value: $steps.listPets.outputs.pets[0].id
        successCriteria:
          - condition: $statusCode == 200
        outputs:
          pet: $response.body
    outputs:
      pet: $steps.getPet.outputs.pet
`,
  },
  {
    name: "README.md",
    content: `# Canopy Model Editor — Pet Store sample

Three files, each opening in its own visual editor:

- **schema.prisma** — a Prisma data model (\`Owner\` 1—N \`Pet\`). Drag entities,
  draw relations, and export to SQL / JSON Schema / Mermaid.
- **main.tsp** — a TypeSpec Pet Store API with a model and two operations.
- **workflow.arazzo.yaml** — an Arazzo workflow whose steps reference the API's
  operations; \`x-typespec-source\` links it back to \`main.tsp\` so the editor can
  trace steps → endpoints → entities.

Open any file to start editing. To see the raw text, right-click the tab →
**Reopen Editor With… → Text Editor**.
`,
  },
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

  // Open the Prisma schema in the visual editor to get the user going immediately.
  await vscode.commands.executeCommand(
    "vscode.openWith",
    vscode.Uri.file(path.join(baseDir, "schema.prisma")),
    ModelEditorProvider.viewType,
  );
  vscode.window.showInformationMessage(`Pet Store sample project created in ${baseDir}.`);
}
