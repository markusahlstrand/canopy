// A tiny dependency-layered layout shared by the Entities ER graph and the Flows
// DAG. Nodes are placed in columns by longest-path depth from a root; within a
// column they stack vertically. Cycles are tolerated (a back-edge just doesn't
// deepen the target). Good enough for read-only diagrams without a layout dep.

export interface LayoutItem {
  id: string;
  /** Ids this node depends on / points at (drives the column it lands in). */
  deps: string[];
}

export interface XY {
  x: number;
  y: number;
}

export function layeredPositions(items: LayoutItem[], opts: { dx?: number; dy?: number } = {}): Map<string, XY> {
  const dx = opts.dx ?? 300;
  const dy = opts.dy ?? 140;
  const ids = new Set(items.map((i) => i.id));
  const depsById = new Map(items.map((i) => [i.id, i.deps.filter((d) => ids.has(d) && d !== i.id)]));

  const depth = new Map<string, number>();
  const computing = new Set<string>();
  const depthOf = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (computing.has(id)) return 0; // cycle guard
    computing.add(id);
    const deps = depsById.get(id) ?? [];
    const d = deps.length ? Math.max(...deps.map(depthOf)) + 1 : 0;
    computing.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const i of items) depthOf(i.id);

  const byColumn = new Map<number, string[]>();
  for (const i of items) {
    const d = depth.get(i.id) ?? 0;
    if (!byColumn.has(d)) byColumn.set(d, []);
    byColumn.get(d)!.push(i.id);
  }

  const pos = new Map<string, XY>();
  for (const [col, members] of byColumn) {
    const offset = ((members.length - 1) * dy) / 2;
    members.forEach((id, row) => pos.set(id, { x: col * dx, y: row * dy - offset }));
  }
  return pos;
}
