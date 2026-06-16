import type { DomainModel } from "./types";

/** One model in the local library, with its last-saved timestamp. */
export interface StoredModel {
  id: string;
  model: DomainModel;
  updatedAt: number;
}

export interface Library {
  models: StoredModel[];
  currentId: string | null;
}

const KEY = "canopy.model-editor.v1";

/** Read the saved library. Returns an empty one on first run or if corrupt. */
export function loadLibrary(): Library {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { models: [], currentId: null };
    const data = JSON.parse(raw) as Partial<Library>;
    const models = Array.isArray(data.models) ? data.models.filter(isStored) : [];
    // Only honour a stored currentId that still points at a loaded model (it may have
    // been deleted) — otherwise fall back to the first model so selection isn't broken.
    const currentId = models.some((m) => m.id === data.currentId) ? data.currentId! : (models[0]?.id ?? null);
    return { models, currentId };
  } catch {
    return { models: [], currentId: null };
  }
}

/** Persist the library. Silently ignores quota / private-mode failures. */
export function saveLibrary(lib: Library): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(lib));
  } catch {
    /* storage unavailable — the canvas keeps working in-memory */
  }
}

function isStored(v: unknown): v is StoredModel {
  const m = v as StoredModel | null;
  return !!m && typeof m.id === "string" && !!m.model && Array.isArray(m.model.entities);
}
