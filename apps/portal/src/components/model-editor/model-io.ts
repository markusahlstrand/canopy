import {
  ACCENT_KEYS,
  PROPERTY_TYPES,
  uid,
  type AccentKey,
  type Cardinality,
  type DomainModel,
  type Entity,
  type Property,
  type PropertyType,
  type Relation,
} from "./types";

const TYPE_SET = new Set<string>(PROPERTY_TYPES);
const CARD_SET = new Set<string>(["1-1", "1-N", "N-1", "N-M"]);
const ACCENT_SET = new Set<string>(ACCENT_KEYS);

/**
 * Coerce loosely-typed data (parsed JSON, or the assistant's proposal) into a
 * valid DomainModel. Unknown property types fall back to "string"; missing ids
 * are minted; positions are auto-laid-out when absent. Throws only when the
 * input isn't shaped like a model at all.
 */
export function coerceModel(input: unknown, opts: { layout?: boolean } = {}): DomainModel {
  if (!input || typeof input !== "object") throw new Error("Not a model object");
  const obj = input as Record<string, unknown>;
  const rawEntities = Array.isArray(obj.entities) ? obj.entities : [];
  if (!rawEntities.length && !Array.isArray(obj.relations)) {
    throw new Error("Model has no entities");
  }

  // First pass: build entities and remember name→id so relations can use either.
  const byName = new Map<string, string>();
  const entities: Entity[] = rawEntities.map((raw, i) => {
    const e = (raw ?? {}) as Record<string, unknown>;
    const id = typeof e.id === "string" && e.id ? e.id : uid("ent");
    const name = typeof e.name === "string" && e.name ? e.name : `Entity${i + 1}`;
    byName.set(name.toLowerCase(), id);
    byName.set(id, id);
    const color: AccentKey =
      typeof e.color === "string" && ACCENT_SET.has(e.color)
        ? (e.color as AccentKey)
        : ACCENT_KEYS[i % ACCENT_KEYS.length]!;
    const pos =
      e.position && typeof e.position === "object"
        ? (e.position as { x?: number; y?: number })
        : undefined;
    return {
      id,
      name,
      description: typeof e.description === "string" ? e.description : undefined,
      color,
      position: { x: Number(pos?.x ?? 0), y: Number(pos?.y ?? 0) },
      properties: coerceProperties(e.properties),
    };
  });

  // Resolve ref-type property targets that referenced names.
  for (const e of entities) {
    for (const p of e.properties) {
      if (p.type === "ref" && p.refEntityId) {
        p.refEntityId = byName.get(p.refEntityId.toLowerCase()) ?? p.refEntityId;
      }
    }
  }

  const rawRelations = Array.isArray(obj.relations) ? obj.relations : [];
  const relations: Relation[] = rawRelations
    .map((raw): Relation | null => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const fromRaw = str(r.from) ?? str(r.fromEntityId) ?? str(r.source);
      const toRaw = str(r.to) ?? str(r.toEntityId) ?? str(r.target);
      const from = fromRaw ? byName.get(fromRaw.toLowerCase()) : undefined;
      const to = toRaw ? byName.get(toRaw.toLowerCase()) : undefined;
      if (!from || !to) return null;
      const card = str(r.cardinality);
      return {
        id: str(r.id) ?? uid("rel"),
        name: str(r.name),
        fromEntityId: from,
        toEntityId: to,
        cardinality: (card && CARD_SET.has(card) ? card : "1-N") as Cardinality,
        fromLabel: str(r.fromLabel),
        toLabel: str(r.toLabel),
      } satisfies Relation;
    })
    .filter((r): r is Relation => r !== null);

  const model: DomainModel = {
    name: typeof obj.name === "string" && obj.name ? obj.name : "Untitled model",
    version: typeof obj.version === "number" ? obj.version : 1,
    entities,
    relations,
  };

  const needsLayout =
    opts.layout || entities.every((e) => e.position.x === 0 && e.position.y === 0);
  if (needsLayout) layout(model);
  return model;
}

function coerceProperties(raw: unknown): Property[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const p = (item ?? {}) as Record<string, unknown>;
    const type = (str(p.type) ?? "string").toLowerCase();
    return {
      id: str(p.id) ?? uid("prop"),
      name: str(p.name) ?? "field",
      type: (TYPE_SET.has(type) ? type : "string") as PropertyType,
      required: Boolean(p.required),
      unique: Boolean(p.unique),
      primaryKey: Boolean(p.primaryKey ?? p.pk),
      enumValues: Array.isArray(p.enumValues) ? p.enumValues.map(String) : undefined,
      refEntityId: str(p.refEntityId) ?? str(p.ref) ?? undefined,
      description: str(p.description),
    } satisfies Property;
  });
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length ? v : undefined;
}

/**
 * A tidy grid layout. Entities sized to their property count so taller boxes get
 * more vertical room. Good enough for a first pass; the user drags from there.
 */
export function layout(model: DomainModel): void {
  const COLS = Math.max(1, Math.ceil(Math.sqrt(model.entities.length)));
  const COL_W = 320;
  const ROW_H = 60;
  const colHeights = new Array(COLS).fill(40);
  model.entities.forEach((e, i) => {
    const col = i % COLS;
    e.position = { x: 60 + col * COL_W, y: colHeights[col] };
    const h = 70 + Math.max(1, e.properties.length) * 30 + 40;
    colHeights[col] += Math.ceil(h / ROW_H) * ROW_H + 40;
  });
}
