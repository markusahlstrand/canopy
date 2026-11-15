/**
 * Lays a flow out left to right with ELK's layered algorithm, as the model editor does: for flows
 * that have no positions yet (those converted from before flows were graphs), and "Tidy up".
 */
import type { ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { FlowGraph } from './flow-graph-edit';

/** The card size the canvas draws, a little generous: extra gap is harmless, overlap isn't. */
export const STEP_WIDTH = 240;
export const STEP_HEIGHT = 90;

// In-thread (no worker to set up), and one engine for every layout a session makes. Loaded on
// first use: ELK is over a megabyte, and most visits to the drive never lay out a flow.
let engine: Promise<{ layout: (graph: ElkNode) => Promise<ElkNode> }> | null = null;
const elk = () => (engine ??= import('elkjs/lib/elk.bundled.js').then((m) => new m.default()));

export async function layoutGraph(graph: FlowGraph): Promise<Map<string, { x: number; y: number }>> {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const root: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
      'elk.spacing.nodeNode': '48',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    },
    children: graph.nodes.map((n) => ({ id: n.id, width: STEP_WIDTH, height: STEP_HEIGHT })),
    edges: graph.edges
      .filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
      .map((e) => ({ id: `${e.from}:${e.branch}`, sources: [e.from], targets: [e.to] })),
  };
  const out = new Map<string, { x: number; y: number }>();
  try {
    const result = await (await elk()).layout(root);
    for (const child of result.children ?? []) if (typeof child.x === 'number' && typeof child.y === 'number') out.set(child.id, { x: child.x, y: child.y });
  } catch {
    // A row beats an empty canvas.
    graph.nodes.forEach((n, i) => out.set(n.id, { x: i * (STEP_WIDTH + 60), y: 0 }));
  }
  return out;
}
