import { useRef } from 'react';
import { Button, Icon, Input } from '@canopy/ui';
import { VIEW_KEYS, type SpaceView, type ViewKey } from '../../src/space-settings';
import { viewIdFor, VIEW_KEY_LABEL } from './space-views';

const MAX_VIEWS = 12, MAX_LEVELS = 4;
const select = 'h-8 rounded-md border border-input bg-background px-2 text-sm';

/**
 * The space's saved views, edited in place: each a name and the levels it groups by, in order.
 * And the one members open unless they pick another. A saved view's id never changes, because a
 * member's own pick is kept by id.
 */
export function ViewsEditor({ value, defaultView, onChange, disabled, savedIds = [] }: {
  value: SpaceView[];
  defaultView: string | undefined;
  onChange: (views: SpaceView[], defaultView: string | undefined) => void;
  disabled?: boolean;
  savedIds?: readonly string[];
}) {
  const fresh = useRef(new Set<string>());
  // A default that names a view no longer in the list goes with it, so the saved default is always real.
  const commit = (views: SpaceView[], next = defaultView) => onChange(views, next && views.some(v => v.id === next) ? next : undefined);
  const update = (i: number, patch: Partial<SpaceView>) => {
    let renamedFrom: string | null = null, renamedTo: string | null = null;
    const views = value.map((view, j) => {
      if (j !== i) return view;
      const next = { ...view, ...patch };
      if (patch.name !== undefined && fresh.current.has(view.id) && !savedIds.includes(view.id)) {
        next.id = viewIdFor(patch.name, value.filter((_, k) => k !== i).map(o => o.id));
        fresh.current.delete(view.id); fresh.current.add(next.id);
        renamedFrom = view.id; renamedTo = next.id;
      }
      return next;
    });
    commit(views, defaultView === renamedFrom && renamedTo ? renamedTo : defaultView);
  };
  const add = () => {
    const id = viewIdFor('New view', value.map(v => v.id));
    fresh.current.add(id);
    commit([...value, { id, name: 'New view', groupBy: ['category', 'year'] }]);
  };
  const setLevel = (i: number, depth: number, key: ViewKey) => update(i, { groupBy: value[i]!.groupBy.map((k, d) => d === depth ? key : k) });
  const addLevel = (i: number) => {
    const unused = VIEW_KEYS.find(key => !value[i]!.groupBy.includes(key));
    if (unused) update(i, { groupBy: [...value[i]!.groupBy, unused] });
  };
  const removeLevel = (i: number, depth: number) => update(i, { groupBy: value[i]!.groupBy.filter((_, d) => d !== depth) });

  return <div className="space-y-2">
    {value.length ? <ul className="space-y-2" aria-label="Views">
      {value.map((view, i) => <li key={i} className="space-y-2 rounded-lg border p-2">
        <div className="flex items-center gap-2">
          <Input aria-label={`View ${i + 1} name`} value={view.name} maxLength={60} disabled={disabled} onChange={e => update(i, { name: e.target.value })} />
          <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${view.name || 'view'}`} disabled={disabled}
            onClick={() => commit(value.filter((_, j) => j !== i))}><Icon name="trash" size={14} /></Button>
        </div>
        <ol className="flex flex-wrap items-center gap-1.5" aria-label={`Levels of ${view.name || 'this view'}`}>
          {view.groupBy.map((key, depth) => <li key={depth} className="flex items-center gap-1">
            {depth ? <Icon name="chevron-right" className="size-3.5 text-muted-foreground" /> : null}
            <select aria-label={`Level ${depth + 1} of ${view.name || 'this view'}`} className={select} disabled={disabled} value={key}
              onChange={e => setLevel(i, depth, e.target.value as ViewKey)}>
              {VIEW_KEYS.filter(k => k === key || !view.groupBy.includes(k)).map(k => <option key={k} value={k}>{VIEW_KEY_LABEL[k]}</option>)}
            </select>
            {view.groupBy.length > 1 ? <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove level ${depth + 1}`} disabled={disabled}
              onClick={() => removeLevel(i, depth)}><Icon name="x" /></Button> : null}
          </li>)}
          {view.groupBy.length < MAX_LEVELS ? <li><Button type="button" variant="ghost" size="xs" disabled={disabled} onClick={() => addLevel(i)}><Icon name="plus" size={12} /> Level</Button></li> : null}
        </ol>
      </li>)}
    </ul> : <p className="text-xs text-muted-foreground">No views yet. Members see the folders.</p>}
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Button type="button" variant="outline" size="sm" disabled={disabled || value.length >= MAX_VIEWS} onClick={add}><Icon name="plus" size={14} /> Add view</Button>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">Members open
        <select aria-label="Default view" className={select} disabled={disabled} value={defaultView ?? ''}
          onChange={e => commit(value, e.target.value || undefined)}>
          <option value="">Folders</option>
          {value.map(view => <option key={view.id} value={view.id}>{view.name || 'Untitled view'}</option>)}
        </select>
      </label>
    </div>
  </div>;
}
