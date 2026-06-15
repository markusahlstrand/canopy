// The domain-model vocabulary the editor works in. Kept deliberately small and
// serialisable so it round-trips cleanly to/from JSON and the AI assistant.

/** Scalar + structural property types the editor understands. */
export const PROPERTY_TYPES = [
  "string",
  "text",
  "integer",
  "float",
  "decimal",
  "boolean",
  "date",
  "datetime",
  "uuid",
  "json",
  "enum",
  "ref",
] as const;

export type PropertyType = (typeof PROPERTY_TYPES)[number];

export interface Property {
  id: string;
  name: string;
  type: PropertyType;
  required?: boolean;
  unique?: boolean;
  /** Marks the entity's primary key. There can be more than one (composite). */
  primaryKey?: boolean;
  /** Allowed values when `type === "enum"`. */
  enumValues?: string[];
  /** Target entity id when `type === "ref"` (a foreign key by hand). */
  refEntityId?: string;
  description?: string;
}

/** A box on the canvas. Position lives on the React Flow node, not here. */
export interface EntityData {
  name: string;
  description?: string;
  properties: Property[];
  /** One of the accent keys below; drives the node's header colour. */
  color?: AccentKey;
}

export interface Entity extends EntityData {
  id: string;
  position: { x: number; y: number };
}

/**
 * Read as "from" → "to". `1-N` means one `from` has many `to`
 * (e.g. one Author has many Books). `N-M` is many-to-many.
 */
export type Cardinality = "1-1" | "1-N" | "N-1" | "N-M";

export interface RelationData {
  name?: string;
  cardinality: Cardinality;
  /** Label shown near the source/target ends (e.g. "writes", "belongs to"). */
  fromLabel?: string;
  toLabel?: string;
  /** Allows storing this directly on a React Flow edge's `data` bag. */
  [key: string]: unknown;
}

export interface Relation extends RelationData {
  id: string;
  fromEntityId: string;
  toEntityId: string;
}

/** The whole model — the unit we export and the assistant proposes. */
export interface DomainModel {
  name: string;
  version: number;
  entities: Entity[];
  relations: Relation[];
}

// ── Presentation accents ──────────────────────────────────────────────────────

export const ACCENTS = {
  green: { dot: "#16a34a", ring: "rgba(22,163,74,0.4)", soft: "rgba(22,163,74,0.10)" },
  blue: { dot: "#2563eb", ring: "rgba(37,99,235,0.4)", soft: "rgba(37,99,235,0.10)" },
  violet: { dot: "#7c3aed", ring: "rgba(124,58,237,0.4)", soft: "rgba(124,58,237,0.10)" },
  orange: { dot: "#ea580c", ring: "rgba(234,88,12,0.4)", soft: "rgba(234,88,12,0.10)" },
  rose: { dot: "#e11d48", ring: "rgba(225,29,72,0.4)", soft: "rgba(225,29,72,0.10)" },
  cyan: { dot: "#0891b2", ring: "rgba(8,145,178,0.4)", soft: "rgba(8,145,178,0.10)" },
  amber: { dot: "#d97706", ring: "rgba(217,119,6,0.4)", soft: "rgba(217,119,6,0.10)" },
  zinc: { dot: "#52525b", ring: "rgba(82,82,91,0.4)", soft: "rgba(82,82,91,0.10)" },
} as const;

export type AccentKey = keyof typeof ACCENTS;
export const ACCENT_KEYS = Object.keys(ACCENTS) as AccentKey[];

export const CARDINALITIES: { value: Cardinality; label: string }[] = [
  { value: "1-1", label: "One-to-one (1:1)" },
  { value: "1-N", label: "One-to-many (1:N)" },
  { value: "N-1", label: "Many-to-one (N:1)" },
  { value: "N-M", label: "Many-to-many (N:M)" },
];

let counter = 0;
/** Short, collision-resistant id without pulling in a uuid dep. */
export function uid(prefix = "id"): string {
  counter += 1;
  const rand = Math.floor(Math.random() * 1e6).toString(36);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}
