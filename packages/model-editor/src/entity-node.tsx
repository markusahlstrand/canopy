import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { ACCENTS, type AccentKey, type Property } from "./types";

export interface EntityNodeData {
  name: string;
  description?: string;
  properties: Property[];
  color?: AccentKey;
  [key: string]: unknown;
}

const TYPE_ABBREV: Record<string, string> = {
  string: "str",
  text: "txt",
  integer: "int",
  float: "flt",
  decimal: "dec",
  boolean: "bool",
  date: "date",
  datetime: "dt",
  uuid: "uuid",
  json: "json",
  enum: "enum",
  ref: "ref",
};

function EntityNodeImpl({ data, selected }: NodeProps) {
  const d = data as EntityNodeData;
  const accent = ACCENTS[d.color ?? "zinc"];
  return (
    <div
      className="w-[240px] overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm transition-shadow"
      style={{
        borderColor: selected ? accent.dot : "var(--border)",
        boxShadow: selected ? `0 0 0 2px ${accent.ring}` : undefined,
      }}
    >
      <Handle
        id="in"
        type="target"
        position={Position.Left}
        className="!h-3 !w-3 !border-2 !border-background"
        style={{ background: accent.dot }}
      />
      <Handle
        id="out"
        type="source"
        position={Position.Right}
        className="!h-3 !w-3 !border-2 !border-background"
        style={{ background: accent.dot }}
      />

      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ background: accent.soft, borderBottom: `1px solid var(--border)` }}
      >
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: accent.dot }} />
        <span className="truncate text-[13px] font-semibold tracking-tight">{d.name}</span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
          {d.properties.length}
        </span>
      </div>

      {d.properties.length === 0 ? (
        <div className="px-3 py-2.5 text-[12px] italic text-muted-foreground">No properties yet</div>
      ) : (
        <ul className="divide-y">
          {d.properties.map((p) => (
            <li key={p.id} className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
              {p.primaryKey ? (
                <span title="Primary key" className="font-mono text-[10px] text-amber-500">
                  PK
                </span>
              ) : p.type === "ref" ? (
                <span title="Reference" className="font-mono text-[10px] text-sky-500">
                  FK
                </span>
              ) : (
                <span className="w-[14px]" />
              )}
              <span className="truncate font-medium">{p.name}</span>
              {p.required && <span className="text-rose-400" title="Required">*</span>}
              <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {TYPE_ABBREV[p.type] ?? p.type}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const EntityNode = memo(EntityNodeImpl);
