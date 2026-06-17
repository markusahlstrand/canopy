// Owns the editable entity layout: the working sidecar (with its named views), the
// staged-in-IndexedDB draft, and the commit-to-repo action. Drags mutate the working
// copy and stage to idb; nothing touches the source files until `commit()` writes the
// `canopy.layout.json` sidecar back through the host.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@canopy/ui";
import type { LayoutSidecar, LayoutView, ProjectGraph } from "./graph-types";
import type { XY } from "./layout";
import { newView, parseSidecar, serializeSidecar, SIDECAR_NAME } from "./layout-sidecar";
import { deleteDraft, getDraft, putDraft } from "./drafts-store";

/** Writes the sidecar text to the repo, returning the (possibly new) file id. */
export type CommitLayoutFn = (text: string, fileId: string | undefined) => Promise<string | undefined>;

export interface LayoutController {
  views: LayoutView[];
  activeViewId: string;
  /** Entity (ER) positions for the active view. */
  positions: Record<string, XY>;
  hasOverrides: boolean;
  /** Flow-step positions for the active view. */
  stepPositions: Record<string, XY>;
  hasStepOverrides: boolean;
  /** Active tag include-filter for this view (empty ⇒ show all). */
  tagFilter: string[];
  setTagFilter: (tags: string[]) => void;
  dirty: boolean;
  committing: boolean;
  canCommit: boolean;
  switchView: (id: string) => void;
  addView: () => void;
  renameView: () => void;
  deleteView: () => void;
  move: (id: string, xy: XY) => void;
  resetActive: () => void;
  moveStep: (id: string, xy: XY) => void;
  resetSteps: () => void;
  commit: () => void;
}

const clone = (s: LayoutSidecar): LayoutSidecar => JSON.parse(JSON.stringify(s));

export function useLayout(projectKey: string, graph: ProjectGraph, onCommit?: CommitLayoutFn): LayoutController {
  const [committed, setCommitted] = useState<LayoutSidecar>(graph.layout);
  const [working, setWorking] = useState<LayoutSidecar>(graph.layout);
  const [activeViewId, setActiveViewId] = useState(graph.layout.views[0]?.id ?? "default");
  const [layoutFileId, setLayoutFileId] = useState(graph.layoutFileId);
  const [committing, setCommitting] = useState(false);

  // (Re)load when the project or a fresh build arrives: stage from idb if a draft
  // exists, else start from the committed sidecar.
  const rehydrating = useRef(false);
  useEffect(() => {
    let alive = true;
    // Block draft persistence until the async load lands the new project's `working`,
    // otherwise the debounced writer can flush the *previous* project's layout into the
    // *new* project's draft (deps fire with stale `working` on the projectKey change).
    rehydrating.current = true;
    setCommitted(graph.layout);
    setLayoutFileId(graph.layoutFileId);
    (async () => {
      const draft = await getDraft(projectKey, SIDECAR_NAME);
      if (!alive) return;
      const w = draft ? parseSidecar(draft) : graph.layout;
      setWorking(w);
      setActiveViewId((id) => (w.views.some((v) => v.id === id) ? id : w.views[0]?.id ?? "default"));
      rehydrating.current = false;
    })();
    return () => {
      alive = false;
    };
  }, [projectKey, graph]);

  const dirty = useMemo(() => serializeSidecar(working) !== serializeSidecar(committed), [working, committed]);

  // Stage the working copy to idb (debounced); clear it once it matches committed.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => {
      if (rehydrating.current) return; // mid-project-switch: `working` is still the old project's
      if (dirty) void putDraft(projectKey, SIDECAR_NAME, serializeSidecar(working));
      else void deleteDraft(projectKey, SIDECAR_NAME);
    }, 500);
    return () => clearTimeout(t);
  }, [working, dirty, projectKey]);

  const activeView = working.views.find((v) => v.id === activeViewId) ?? working.views[0];
  const positions = activeView?.entities ?? {};
  const stepPositions = activeView?.steps ?? {};
  const tagFilter = activeView?.tagFilter ?? [];

  const mutateActive = useCallback(
    (fn: (v: LayoutView) => void) => {
      setWorking((w) => {
        const next = clone(w);
        const v = next.views.find((x) => x.id === activeViewId) ?? next.views[0];
        if (v) fn(v);
        return next;
      });
    },
    [activeViewId],
  );

  const move = useCallback((id: string, xy: XY) => mutateActive((v) => void (v.entities[id] = xy)), [mutateActive]);
  const resetActive = useCallback(() => mutateActive((v) => void (v.entities = {})), [mutateActive]);
  // Older drafts/views may predate `steps`; default the map before writing into it.
  const moveStep = useCallback((id: string, xy: XY) => mutateActive((v) => void ((v.steps ??= {})[id] = xy)), [mutateActive]);
  const resetSteps = useCallback(() => mutateActive((v) => void (v.steps = {})), [mutateActive]);
  const setTagFilter = useCallback((tags: string[]) => mutateActive((v) => void (v.tagFilter = tags)), [mutateActive]);

  const switchView = useCallback((id: string) => setActiveViewId(id), []);

  const addView = useCallback(() => {
    const name = window.prompt("New view name", `View ${working.views.length + 1}`)?.trim();
    if (!name) return;
    const v = newView(name);
    setWorking((w) => ({ ...w, views: [...w.views, v] }));
    setActiveViewId(v.id);
  }, [working.views.length]);

  const renameView = useCallback(() => {
    const current = working.views.find((v) => v.id === activeViewId);
    const name = window.prompt("Rename view", current?.name ?? "")?.trim();
    if (!name) return;
    setWorking((w) => ({ ...w, views: w.views.map((v) => (v.id === activeViewId ? { ...v, name } : v)) }));
  }, [working.views, activeViewId]);

  const deleteView = useCallback(() => {
    if (working.views.length <= 1) return;
    setWorking((w) => {
      const views = w.views.filter((v) => v.id !== activeViewId);
      setActiveViewId(views[0]!.id);
      return { ...w, views };
    });
  }, [working.views.length, activeViewId]);

  const commit = useCallback(() => {
    if (!onCommit || committing) return;
    setCommitting(true);
    void (async () => {
      try {
        const id = await onCommit(serializeSidecar(working), layoutFileId);
        setCommitted(working);
        if (id) setLayoutFileId(id);
        await deleteDraft(projectKey, SIDECAR_NAME);
        toast.success("Layout committed");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Couldn't commit layout");
      } finally {
        setCommitting(false);
      }
    })();
  }, [onCommit, committing, working, layoutFileId, projectKey]);

  return {
    views: working.views,
    activeViewId: activeView?.id ?? activeViewId,
    positions,
    hasOverrides: Object.keys(positions).length > 0,
    stepPositions,
    hasStepOverrides: Object.keys(stepPositions).length > 0,
    tagFilter,
    setTagFilter,
    dirty,
    committing,
    canCommit: !!onCommit,
    switchView,
    addView,
    renameView,
    deleteView,
    move,
    resetActive,
    moveStep,
    resetSteps,
    commit,
  };
}
