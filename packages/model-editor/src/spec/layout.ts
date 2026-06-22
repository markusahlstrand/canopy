// Auto-layout shared by the Entities ER graph and the Flows DAG, backed by ELK
// (the Eclipse Layout Kernel). React Flow ships no layout of its own; ELK's `layered`
// (Sugiyama) algorithm ranks nodes left→right by dependency, minimizes edge crossings,
// and packs each rank using the node's real width/height so tall entity cards never
// overlap. It beats a plain layered stacker on ER graphs specifically: BRANDES_KOEPF
// node placement keeps related cards aligned and orthogonal routing leaves clean gutters
// for the FK edges. ELK is async (it returns a Promise), so callers compute layout in an
// effect and store the result — see entities-tab / flows-tab.

import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";

export interface LayoutItem {
  id: string;
  /** Ids this node depends on / points at; the edge that ranks it to the right. */
  deps: string[];
  /** Rendered size. Slightly over-estimate height: extra gap is harmless, overlap isn't. */
  width?: number;
  height?: number;
}

export interface XY {
  x: number;
  y: number;
}

export interface LayoutOpts {
  /** Default node box when an item omits its size. */
  width?: number;
  height?: number;
  /** Gap between nodes in the same rank (cross-axis) and between ranks (main-axis). */
  nodesep?: number;
  ranksep?: number;
}

// One engine for the whole module. `elk.bundled.js` runs in-thread (no worker setup),
// and a single instance is reused across the many layout calls a session makes.
const elk = new ELK();

/**
 * Lay items out left→right by dependency and return each node's **top-left** position
 * (ELK and React Flow agree on top-left origin, so no centre adjustment is needed).
 * An empty input resolves to an empty map. Never throws: on an ELK failure it falls
 * back to a simple stacked column so the canvas still renders.
 */
export async function layeredPositions(items: LayoutItem[], opts: LayoutOpts = {}): Promise<Map<string, XY>> {
  const pos = new Map<string, XY>();
  if (!items.length) return pos;

  const dw = opts.width ?? 230;
  const dh = opts.height ?? 120;
  const ids = new Set(items.map((i) => i.id));

  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      // ranksep ↔ between layers (main axis); nodesep ↔ within a layer (cross axis).
      "elk.layered.spacing.nodeNodeBetweenLayers": String(opts.ranksep ?? 110),
      "elk.spacing.nodeNode": String(opts.nodesep ?? 48),
      // Straightens chains of related cards and keeps the FK gutters clean.
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.cycleBreaking.strategy": "GREEDY",
      "elk.edgeRouting": "ORTHOGONAL",
    },
    children: items.map((i) => ({ id: i.id, width: i.width ?? dw, height: i.height ?? dh })),
    edges: items.flatMap((i) =>
      // dep ranks left of the node; skip self-loops and dangling refs with no node.
      i.deps
        .filter((dep) => dep !== i.id && ids.has(dep))
        .map((dep) => ({ id: `${dep}->${i.id}`, sources: [dep], targets: [i.id] })),
    ),
  };

  try {
    const res = await elk.layout(graph);
    for (const child of res.children ?? []) {
      if (typeof child.x === "number" && typeof child.y === "number") pos.set(child.id, { x: child.x, y: child.y });
    }
  } catch {
    // Degrade gracefully — a single column beats an empty canvas.
    let y = 0;
    for (const i of items) {
      pos.set(i.id, { x: 0, y });
      y += (i.height ?? dh) + (opts.nodesep ?? 48);
    }
  }
  return pos;
}
