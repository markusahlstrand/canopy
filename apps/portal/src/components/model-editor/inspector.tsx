import { Button } from "@canopy/ui";
import { Checkbox } from "@canopy/ui";
import { Input } from "@canopy/ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@canopy/ui";
import { Icon } from "@canopy/ui";
import { cn } from "@canopy/ui";
import type { EntityNodeData } from "./entity-node";
import {
  ACCENT_KEYS,
  ACCENTS,
  CARDINALITIES,
  PROPERTY_TYPES,
  type AccentKey,
  type Property,
  type RelationData,
} from "./types";

export interface InspectorProps {
  entity: { id: string; data: EntityNodeData } | null;
  relation: { id: string; data: RelationData; fromName: string; toName: string } | null;
  entities: { id: string; name: string }[];
  onUpdateEntity: (id: string, patch: Partial<EntityNodeData>) => void;
  onUpdateProperty: (entityId: string, propId: string, patch: Partial<Property>) => void;
  onAddProperty: (entityId: string) => void;
  onRemoveProperty: (entityId: string, propId: string) => void;
  onMoveProperty: (entityId: string, propId: string, dir: -1 | 1) => void;
  onDeleteEntity: (id: string) => void;
  onUpdateRelation: (id: string, patch: Partial<RelationData>) => void;
  onSwapRelation: (id: string) => void;
  onDeleteRelation: (id: string) => void;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

export function Inspector(props: InspectorProps) {
  const { entity, relation, entities } = props;

  if (!entity && !relation) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="max-w-[220px] text-sm text-muted-foreground">
          <Icon name="package" size={28} className="mx-auto mb-3 opacity-40" />
          Select an entity or a relation to edit it here. Drag the canvas to pan, scroll to zoom.
        </div>
      </div>
    );
  }

  if (relation) {
    const { id, data, fromName, toName } = relation;
    return (
      <div className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <Icon name="link" size={16} />
          <h3 className="text-sm font-semibold">Relation</h3>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto text-muted-foreground hover:text-destructive"
            onClick={() => props.onDeleteRelation(id)}
            title="Delete relation"
          >
            <Icon name="trash" size={15} />
          </Button>
        </div>

        <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-2 text-[12px]">
          <span className="truncate font-medium">{fromName}</span>
          <Icon name="chevron-right" size={14} className="text-muted-foreground" />
          <span className="truncate font-medium">{toName}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            title="Swap direction"
            onClick={() => props.onSwapRelation(id)}
          >
            <Icon name="refresh" size={14} />
          </Button>
        </div>

        <Field label="Name">
          <Input
            value={data.name ?? ""}
            placeholder="e.g. authorship"
            onChange={(e) => props.onUpdateRelation(id, { name: e.target.value })}
          />
        </Field>

        <Field label="Cardinality">
          <Select
            value={data.cardinality}
            onValueChange={(v) => props.onUpdateRelation(id, { cardinality: v as RelationData["cardinality"] })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CARDINALITIES.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="From label">
            <Input
              value={data.fromLabel ?? ""}
              placeholder="writes"
              onChange={(e) => props.onUpdateRelation(id, { fromLabel: e.target.value })}
            />
          </Field>
          <Field label="To label">
            <Input
              value={data.toLabel ?? ""}
              placeholder="written by"
              onChange={(e) => props.onUpdateRelation(id, { toLabel: e.target.value })}
            />
          </Field>
        </div>
      </div>
    );
  }

  // Entity editor
  const { id, data } = entity!;
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <span
          className="h-3 w-3 rounded-full"
          style={{ background: ACCENTS[data.color ?? "zinc"].dot }}
        />
        <h3 className="text-sm font-semibold">Entity</h3>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto text-muted-foreground hover:text-destructive"
          onClick={() => props.onDeleteEntity(id)}
          title="Delete entity"
        >
          <Icon name="trash" size={15} />
        </Button>
      </div>

      <Field label="Name">
        <Input value={data.name} onChange={(e) => props.onUpdateEntity(id, { name: e.target.value })} />
      </Field>

      <Field label="Description">
        <Input
          value={data.description ?? ""}
          placeholder="What does this represent?"
          onChange={(e) => props.onUpdateEntity(id, { description: e.target.value })}
        />
      </Field>

      <Field label="Color">
        <div className="flex flex-wrap gap-1.5">
          {ACCENT_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              title={key}
              onClick={() => props.onUpdateEntity(id, { color: key as AccentKey })}
              className={cn(
                "h-6 w-6 rounded-full ring-offset-2 ring-offset-background transition",
                data.color === key && "ring-2",
              )}
              style={{ background: ACCENTS[key].dot, boxShadow: data.color === key ? `0 0 0 2px ${ACCENTS[key].ring}` : undefined }}
            />
          ))}
        </div>
      </Field>

      <div className="flex items-center justify-between pt-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Properties
        </span>
        <Button variant="outline" size="sm" className="h-7 gap-1" onClick={() => props.onAddProperty(id)}>
          <Icon name="plus" size={13} /> Add
        </Button>
      </div>

      <div className="space-y-2">
        {data.properties.map((p, i) => (
          <PropertyRow
            key={p.id}
            prop={p}
            entities={entities.filter((e) => e.id !== id)}
            first={i === 0}
            last={i === data.properties.length - 1}
            onChange={(patch) => props.onUpdateProperty(id, p.id, patch)}
            onRemove={() => props.onRemoveProperty(id, p.id)}
            onMove={(dir) => props.onMoveProperty(id, p.id, dir)}
          />
        ))}
        {data.properties.length === 0 && (
          <p className="rounded-lg border border-dashed p-3 text-center text-[12px] text-muted-foreground">
            No properties. Click <span className="font-medium">Add</span> to create one.
          </p>
        )}
      </div>
    </div>
  );
}

function PropertyRow({
  prop,
  entities,
  first,
  last,
  onChange,
  onRemove,
  onMove,
}: {
  prop: Property;
  entities: { id: string; name: string }[];
  first: boolean;
  last: boolean;
  onChange: (patch: Partial<Property>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  return (
    <div className="rounded-lg border bg-card p-2">
      <div className="flex items-center gap-1.5">
        <Input
          value={prop.name}
          className="h-8 flex-1"
          onChange={(e) => onChange({ name: e.target.value })}
        />
        <Select value={prop.type} onValueChange={(v) => onChange({ type: v as Property["type"] })}>
          <SelectTrigger size="sm" className="w-[92px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROPERTY_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {prop.type === "enum" && (
        <Input
          className="mt-1.5 h-8 font-mono text-[12px]"
          placeholder="comma,separated,values"
          value={(prop.enumValues ?? []).join(",")}
          onChange={(e) =>
            onChange({
              enumValues: e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
        />
      )}

      {prop.type === "ref" && (
        <Select value={prop.refEntityId ?? ""} onValueChange={(v) => onChange({ refEntityId: v })}>
          <SelectTrigger size="sm" className="mt-1.5 w-full">
            <SelectValue placeholder="References…" />
          </SelectTrigger>
          <SelectContent>
            {entities.length === 0 ? (
              <div className="px-2 py-1.5 text-[12px] text-muted-foreground">No other entities</div>
            ) : (
              entities.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.name}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      )}

      <div className="mt-2 flex items-center gap-3 text-[11px]">
        <Flag label="PK" checked={!!prop.primaryKey} onChange={(c) => onChange({ primaryKey: c })} />
        <Flag label="Req" checked={!!prop.required} onChange={(c) => onChange({ required: c })} />
        <Flag label="Uniq" checked={!!prop.unique} onChange={(c) => onChange({ unique: c })} />
        <div className="ml-auto flex items-center gap-0.5">
          <Button variant="ghost" size="icon-sm" disabled={first} onClick={() => onMove(-1)} title="Move up">
            <Icon name="chevron-down" size={14} className="rotate-180" />
          </Button>
          <Button variant="ghost" size="icon-sm" disabled={last} onClick={() => onMove(1)} title="Move down">
            <Icon name="chevron-down" size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={onRemove}
            title="Remove property"
          >
            <Icon name="x" size={14} />
          </Button>
        </div>
      </div>
    </div>
  );
}

function Flag({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (c: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer select-none items-center gap-1">
      <Checkbox checked={checked} onCheckedChange={(c) => onChange(c === true)} className="h-3.5 w-3.5" />
      <span className="text-muted-foreground">{label}</span>
    </label>
  );
}
