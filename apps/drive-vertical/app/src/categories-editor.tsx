import { useRef } from 'react';
import { Button, Icon, Input } from '@canopy/ui';
import type { SpaceCategory } from '../../src/space-settings';

/** A category id from its name: stable once made, so renaming a category never breaks a flow. */
export function categoryIdFor(name: string, taken: readonly string[]): string {
  const base = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'category';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * The space's categories, edited in place. Document AI picks one per document from this list,
 * and flows match on it. A hint is what the model reads to decide, so it says what belongs.
 */
export function CategoriesEditor({ value, onChange, disabled, savedIds = [] }: {
  value: SpaceCategory[]; onChange: (next: SpaceCategory[]) => void; disabled?: boolean;
  /** Ids already saved, which flows may reference: these never change, whatever this session made. */
  savedIds?: readonly string[];
}) {
  // Ids made in this editing session follow their name until they are saved; a saved id never changes.
  const fresh = useRef(new Set<string>());
  const update = (i: number, patch: Partial<SpaceCategory>) => onChange(value.map((c, j) => {
    if (j !== i) return c;
    const next = { ...c, ...patch };
    if (patch.name !== undefined && fresh.current.has(c.id) && !savedIds.includes(c.id)) {
      next.id = categoryIdFor(patch.name, value.filter((_, k) => k !== i).map((o) => o.id));
      fresh.current.delete(c.id); fresh.current.add(next.id);
    }
    return next;
  }));
  const add = () => {
    const id = categoryIdFor('New category', value.map((c) => c.id));
    fresh.current.add(id);
    onChange([...value, { id, name: 'New category' }]);
  };
  return (
    <div className="space-y-2">
      {value.length ? <ul className="space-y-2" aria-label="Categories">
        {value.map((c, i) => (
          <li key={i} className="space-y-1 rounded-lg border p-2">
            <div className="flex items-center gap-2">
              <Input aria-label={`Category ${i + 1} name`} value={c.name} maxLength={60} disabled={disabled}
                onChange={(e) => update(i, { name: e.target.value })} />
              <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${c.name || 'category'}`} disabled={disabled}
                onClick={() => onChange(value.filter((_, j) => j !== i))}><Icon name="trash" size={14} /></Button>
            </div>
            <Input aria-label={`What belongs in ${c.name || 'this category'}`} placeholder="What belongs here, in a sentence (optional)" value={c.hint ?? ''} maxLength={200} disabled={disabled}
              onChange={(e) => update(i, { hint: e.target.value || undefined })} />
          </li>
        ))}
      </ul> : <p className="text-xs text-muted-foreground">No categories yet. With none, Document AI only labels and describes.</p>}
      <Button type="button" variant="outline" size="sm" disabled={disabled || value.length >= 30} onClick={add}><Icon name="plus" size={14} /> Add category</Button>
    </div>
  );
}
