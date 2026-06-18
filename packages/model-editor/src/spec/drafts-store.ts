// IndexedDB staging for spec edits. An edit (today: the layout sidecar) is held here
// as a draft keyed by `${projectKey}::${fileName}` until the user explicitly commits
// it back to the repo. This is the client-side "working copy" — it survives reloads
// and lets a connector-backed file accumulate changes before a single commit, instead
// of writing on every drag.

import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "canopy-spec";
const STORE = "drafts";

let dbp: Promise<IDBPDatabase> | null = null;
function db(): Promise<IDBPDatabase> {
  return (dbp ??= openDB(DB_NAME, 1, {
    upgrade(d) {
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
    },
  }));
}

const key = (projectKey: string, fileName: string) => `${projectKey}::${fileName}`;

export async function getDraft(projectKey: string, fileName: string): Promise<string | null> {
  if (!projectKey) return null;
  try {
    return (await (await db()).get(STORE, key(projectKey, fileName))) ?? null;
  } catch {
    return null;
  }
}

export async function putDraft(projectKey: string, fileName: string, text: string): Promise<void> {
  if (!projectKey) return;
  try {
    await (await db()).put(STORE, text, key(projectKey, fileName));
  } catch {
    // storage unavailable — the edit just won't persist across reloads this session
  }
}

export async function deleteDraft(projectKey: string, fileName: string): Promise<void> {
  if (!projectKey) return;
  try {
    await (await db()).delete(STORE, key(projectKey, fileName));
  } catch {
    // ignore
  }
}
