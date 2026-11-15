/**
 * The side panel that edits one step of a flow: what starts it, what a check asks, where a copy
 * goes, which label to add, and where each exit leads.
 */
import { useEffect, useState } from 'react';
import { Button, Checkbox, Icon, Input } from '@canopy/ui';
import { listFoldersPage, ROOT_FOLDER_ID, type FlowCondition, type FlowNode } from './api';
import type { SpaceCategory } from '../../src/space-settings';
import { blankCondition, describeStep, exitsOf, exitTo, type FlowGraph, type Names } from './flow-graph-edit';
import type { FlowBranch } from '@canopy/scope-drive/spec/model';

export type FolderOption = { id: string; path: string };
export type SpaceOption = { slug: string; name: string; a3doc?: boolean };

export const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message || fallback : String(e));
export const folderLabel = (path: string) => path || 'Top level';

/** Every folder of a space, by path, as the caller sees it there: what a copy can go into. */
export async function foldersOf(slug: string, limit = 300): Promise<FolderOption[]> {
  const out: FolderOption[] = [{ id: ROOT_FOLDER_ID, path: '' }];
  const queue = [{ id: ROOT_FOLDER_ID, path: '' }];
  while (queue.length && out.length < limit) {
    const parent = queue.shift()!;
    let next: string | null = null;
    do {
      const page = await listFoldersPage(parent.id, next, slug);
      for (const f of page.entries) {
        const option = { id: f.id, path: parent.path ? `${parent.path}/${f.name}` : f.name };
        out.push(option); queue.push(option);
      }
      next = page.next;
    } while (next && out.length < limit);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// Several cards and the inspector name folders of the same space: list each space once per opening.
const folderCache = new Map<string, Promise<FolderOption[]>>();
export const forgetFolders = () => folderCache.clear();
function cachedFolders(slug: string): Promise<FolderOption[]> {
  let pending = folderCache.get(slug);
  if (!pending) {
    pending = foldersOf(slug);
    folderCache.set(slug, pending);
    pending.catch(() => folderCache.delete(slug));
  }
  return pending;
}

/** The folders of each space named, as they load. A space that failed is left out. */
export function useFolderMap(spaces: readonly string[]): Record<string, FolderOption[]> {
  const [map, setMap] = useState<Record<string, FolderOption[]>>({});
  const key = [...new Set(spaces)].sort().join('\n');
  useEffect(() => {
    let live = true;
    for (const slug of key ? key.split('\n') : []) {
      cachedFolders(slug).then((folders) => { if (live) setMap((m) => (m[slug] === folders ? m : { ...m, [slug]: folders })); }).catch(() => {});
    }
    return () => { live = false; };
  }, [key]);
  return map;
}

const select = 'w-full rounded-md border bg-background p-1.5 text-sm';

const CONDITION_KINDS: { field: FlowCondition['field']; label: string }[] = [
  { field: 'extension', label: 'File type' }, { field: 'folder', label: 'Folder' }, { field: 'name', label: 'File name' },
  { field: 'category', label: 'Category' }, { field: 'label', label: 'Label' }, { field: 'ask', label: 'Ask AI a question' },
];

const STEP_TITLE: Record<FlowNode['type'], string> = {
  trigger: 'What starts it', check: 'Check', approval: 'Wait for approval', copy: 'Copy', label: 'Add a label',
};

const EXIT_LABEL: Record<FlowBranch, string> = { yes: 'If yes, go to', no: 'If no, go to', next: 'Then go to' };

export function StepInspector({ node, graph, names, spaces, categories, categoriesError, busy, onChange, onConnect, onRemove, onClose }: {
  node: FlowNode; graph: FlowGraph; names: Names; spaces: readonly SpaceOption[];
  categories: readonly SpaceCategory[]; categoriesError: string | null; busy: boolean;
  onChange: (node: FlowNode) => void; onConnect: (branch: FlowBranch, to: string | null) => void;
  onRemove: () => void; onClose: () => void;
}) {
  const others = graph.nodes.filter((n) => n.id !== node.id && n.type !== 'trigger');
  return (
    <section aria-label="Step details" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{STEP_TITLE[node.type]}</h3>
        <span className="flex gap-1">
          {node.type !== 'trigger' ? <Button type="button" size="sm" variant="ghost" aria-label="Remove this step" disabled={busy} onClick={onRemove}><Icon name="trash" size={14} /></Button> : null}
          <Button type="button" size="sm" variant="ghost" aria-label="Close step details" onClick={onClose}><Icon name="x" size={14} /></Button>
        </span>
      </div>

      {node.type === 'trigger' ? <TriggerFields node={node} spaces={spaces} busy={busy} onChange={onChange} /> : null}
      {node.type === 'check' ? (
        <div className="space-y-2">
          <label className="block space-y-1"><span className="text-xs text-muted-foreground">Look at</span>
            <select aria-label="What to check" className={select} disabled={busy} value={node.condition.field}
              onChange={(e) => onChange({ ...node, condition: blankCondition(e.target.value as FlowCondition['field'], categories) })}>
              {CONDITION_KINDS.map((k) => <option key={k.field} value={k.field}>{k.label}</option>)}
            </select></label>
          <ConditionFields condition={node.condition} categories={categories} categoriesError={categoriesError} busy={busy} onChange={(condition) => onChange({ ...node, condition })} />
          {node.condition.field === 'ask' ? <p className="text-xs text-muted-foreground">An AI question sends the first part of each document that gets here to a model, once per version. Each one costs a model call.</p> : null}
        </div>
      ) : null}
      {node.type === 'approval' ? <p className="text-xs text-muted-foreground">Each document that gets here waits under “Waiting for you” until you approve or dismiss it.</p> : null}
      {node.type === 'copy' ? <CopyFields node={node} spaces={spaces} busy={busy} onChange={onChange} /> : null}
      {node.type === 'label' ? (
        <label className="block space-y-1"><span className="text-xs text-muted-foreground">Label</span>
          <Input aria-label="Label to add" value={node.value} maxLength={100} placeholder="review" disabled={busy} onChange={(e) => onChange({ ...node, value: e.target.value })} /></label>
      ) : null}

      <div className="space-y-2 border-t pt-3">
        {exitsOf(node).map((branch) => (
          <label key={branch} className="block space-y-1"><span className="text-xs text-muted-foreground">{EXIT_LABEL[branch]}</span>
            <select aria-label={EXIT_LABEL[branch]} className={select} disabled={busy} value={exitTo(graph, node.id, branch) ?? ''}
              onChange={(e) => onConnect(branch, e.target.value || null)}>
              <option value="">{branch === 'no' ? 'Nothing: stop here' : 'Nothing: the flow ends'}</option>
              {others.map((n) => <option key={n.id} value={n.id}>{describeStep(n, names)}</option>)}
            </select></label>
        ))}
      </div>
    </section>
  );
}

function TriggerFields({ node, spaces, busy, onChange }: { node: Extract<FlowNode, { type: 'trigger' }>; spaces: readonly SpaceOption[]; busy: boolean; onChange: (n: FlowNode) => void }) {
  // A space the flow already watches but this person can't list stays visible, so it can be removed.
  const shown = [...spaces, ...node.spaces.filter((s) => !spaces.some((o) => o.slug === s)).map((slug) => ({ slug, name: slug }))];
  return (
    <div className="space-y-3">
      <label className="block space-y-1"><span className="text-xs text-muted-foreground">When</span>
        <select aria-label="When" className={select} disabled={busy} value={node.on}
          onChange={(e) => {
            const on = e.target.value as 'arrived' | 'classified' | 'schedule';
            const { every: _every, ...rest } = node;
            onChange(on === 'schedule' ? { ...rest, on, every: node.every ?? 'day' } : { ...rest, on });
          }}>
          <option value="arrived">A document arrives (uploaded, synced or mailed in)</option>
          <option value="classified">Document AI puts a document in a category</option>
          <option value="schedule">On a schedule, for what arrived since the last run</option>
        </select></label>
      {node.on === 'schedule' ? (
        <label className="block space-y-1"><span className="text-xs text-muted-foreground">How often</span>
          <select aria-label="How often" className={select} disabled={busy} value={node.every ?? 'day'}
            onChange={(e) => onChange({ ...node, every: e.target.value as 'hour' | 'day' | 'week' | 'month' })}>
            <option value="hour">Every hour</option><option value="day">Every day</option><option value="week">Every week</option><option value="month">Every month</option>
          </select></label>
      ) : null}
      <fieldset className="space-y-1"><legend className="text-xs text-muted-foreground">In these spaces</legend>
        {shown.length ? shown.map((s) => (
          <label key={s.slug} className="flex items-center gap-2 text-sm">
            <Checkbox aria-label={`Watch ${s.name}`} checked={node.spaces.includes(s.slug)} disabled={busy || (!node.spaces.includes(s.slug) && node.spaces.length >= 10)}
              onCheckedChange={(on) => onChange({ ...node, spaces: on === true ? [...node.spaces, s.slug] : node.spaces.filter((x) => x !== s.slug) })} />
            {s.name}
          </label>
        )) : <p className="text-xs text-muted-foreground">You need to own a space to watch it.</p>}
      </fieldset>
    </div>
  );
}

const parseList = (text: string, strip = false) =>
  [...new Set(text.split(',').map((v) => { const t = v.trim(); return strip ? t.replace(/^\./, '').toLowerCase() : t; }).filter(Boolean))];

/** A list as typed ("pdf, xml"): the text stays as written, and the list follows it. */
function ListField({ label, placeholder, values, busy, strip, onChange }: { label: string; placeholder: string; values: string[]; busy: boolean; strip?: boolean; onChange: (values: string[]) => void }) {
  const [text, setText] = useState(values.join(', '));
  // A change from outside (another step selected) replaces the text; typing doesn't.
  useEffect(() => {
    if (parseList(text, strip).join() !== values.join()) setText(values.join(', '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values]);
  return <Input aria-label={label} placeholder={placeholder} value={text} disabled={busy}
    onChange={(e) => { setText(e.target.value); onChange(parseList(e.target.value, strip)); }}
    onBlur={() => setText(values.join(', '))} />;
}

export function ConditionFields({ condition: c, categories, categoriesError, busy, onChange }: {
  condition: FlowCondition; categories: readonly SpaceCategory[]; categoriesError: string | null; busy: boolean; onChange: (c: FlowCondition) => void;
}) {
  switch (c.field) {
    case 'folder':
      return <div className="space-y-2">
        <select aria-label="Folder match" className={select} disabled={busy} value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as 'is' | 'under' | 'matches' })}>
          <option value="under">is in or under</option><option value="is">is exactly</option><option value="matches">matches a pattern</option>
        </select>
        <Input aria-label="Folder path" placeholder={c.op === 'matches' ? 'Client invoices/{year}/{month}' : 'Statements (empty: top level)'} value={c.path} disabled={busy} onChange={(e) => onChange({ ...c, path: e.target.value })} />
        {c.op === 'matches' ? <p className="text-xs text-muted-foreground">One folder per level. <code>*</code> is any folder; <code>{'{year}'}</code> takes that folder’s name, for a copy after this check to use.</p> : null}
      </div>;
    case 'name':
      return <div className="space-y-2">
        <select aria-label="Name match" className={select} disabled={busy} value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as 'contains' | 'matches' })}>
          <option value="contains">contains</option><option value="matches">matches (* and ?)</option>
        </select>
        <Input aria-label="Name text" value={c.value} disabled={busy} onChange={(e) => onChange({ ...c, value: e.target.value })} />
      </div>;
    case 'extension':
      return <ListField label="File types" placeholder="pdf, xml" values={c.values} busy={busy} strip onChange={(values) => onChange({ ...c, values })} />;
    case 'category': {
      // Categories ids the watched spaces don't list (renamed away, or typed in) stay visible and removable.
      const known = [...categories, ...c.values.filter((id) => !categories.some((k) => k.id === id)).map((id) => ({ id, name: id }))];
      return <div className="space-y-2">
        {categoriesError ? <p role="alert" className="text-xs text-destructive">{categoriesError}</p> : null}
        {known.length ? <div className="space-y-1">
          {known.map((cat) => (
            <label key={cat.id} className="flex items-center gap-2 text-sm"><Checkbox aria-label={cat.name} checked={c.values.includes(cat.id)} disabled={busy}
              onCheckedChange={(on) => onChange({ ...c, values: on === true ? [...c.values, cat.id] : c.values.filter((v) => v !== cat.id) })} />{cat.name}</label>
          ))}
        </div> : null}
        {!categories.length ? <>
          <p className="text-xs text-muted-foreground">{categoriesError ? 'Type the category ids instead:' : 'The spaces it watches have no categories yet. Add them in space settings, or type category ids:'}</p>
          <ListField label="Category ids" placeholder="bank-statement, invoice" values={c.values} busy={busy} onChange={(values) => onChange({ ...c, values })} />
        </> : null}
        <label className="flex items-center gap-1 text-xs text-muted-foreground">AI at least
          <Input aria-label="Minimum confidence" type="number" min={0} max={100} className="w-16" value={Math.round(c.minConfidence * 100)} disabled={busy}
            onChange={(e) => onChange({ ...c, minConfidence: Math.min(100, Math.max(0, Number(e.target.value) || 0)) / 100 })} />% sure</label>
      </div>;
    }
    case 'label':
      return <Input aria-label="Label" value={c.value} disabled={busy} onChange={(e) => onChange({ ...c, value: e.target.value })} />;
    case 'ask':
      return <Input aria-label="Question for the AI" placeholder="Is this a monthly bank statement?" value={c.question} maxLength={300} disabled={busy} onChange={(e) => onChange({ ...c, question: e.target.value })} />;
  }
}

/** Where a copy goes: a space this person owns, a folder there, and (for a3doc) more categories. */
function CopyFields({ node, spaces, busy, onChange }: { node: Extract<FlowNode, { type: 'copy' }>; spaces: readonly SpaceOption[]; busy: boolean; onChange: (n: FlowNode) => void }) {
  const [folders, setFolders] = useState<FolderOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setFolders(null); setError(null);
    if (!node.space) return;
    let live = true;
    cachedFolders(node.space).then((f) => { if (live) setFolders(f); }).catch((e) => { if (live) setError(message(e, 'Could not list that space’s folders.')); });
    return () => { live = false; };
  }, [node.space]);
  const shown = node.space && !spaces.some((s) => s.slug === node.space) ? [...spaces, { slug: node.space, name: node.space }] : spaces;
  // Only a3doc files one document in several categories.
  const a3doc = spaces.some((s) => s.slug === node.space && s.a3doc);
  return (
    <div className="space-y-2">
      <select aria-label="Space to copy to" className={select} disabled={busy} value={node.space} onChange={(e) => onChange({ ...node, space: e.target.value, folderId: '', alsoIn: [], alsoInPaths: [] })}>
        <option value="">Choose a space…</option>
        {shown.map((s) => <option key={s.slug} value={s.slug}>{s.name}</option>)}
      </select>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {node.space && !folders && !error ? <p role="status" className="text-xs text-muted-foreground">Loading folders…</p> : null}
      {folders ? <>
        <select aria-label="Folder to copy to" className={select} disabled={busy} value={node.folderId} onChange={(e) => onChange({ ...node, folderId: e.target.value })}>
          <option value="">Choose a folder…</option>
          {folders.map((f) => <option key={f.id} value={f.id}>{folderLabel(f.path)}</option>)}
        </select>
        {node.folderId ? (
          <label className="block space-y-1"><span className="text-xs text-muted-foreground">Then into (optional)</span>
            <Input aria-label="Subfolder" placeholder="{year}/{month}" value={node.subfolder ?? ''} disabled={busy}
              onChange={(e) => onChange({ ...node, subfolder: e.target.value })} />
            <span className="block text-xs text-muted-foreground">A path below that folder. Use what a “folder matches” check took, like <code>{'{year}'}</code>; a folder that isn’t there yet is made.</span>
          </label>
        ) : null}
        {a3doc && node.folderId ? (
          <label className="block space-y-1"><span className="text-xs text-muted-foreground">Also file it in, by path (a3doc categories)</span>
            <ListField label="Categories by path" placeholder="Facturas/{year}, Clientes" values={node.alsoInPaths ?? []} busy={busy}
              onChange={(alsoInPaths) => onChange({ ...node, alsoInPaths })} />
          </label>
        ) : null}
        {a3doc && node.folderId && folders.length > 2 ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Also file it in (a3doc categories){node.alsoIn.length ? `: ${node.alsoIn.length}` : ''}</summary>
            <div className="mt-1 max-h-40 space-y-1 overflow-y-auto">
              {folders.filter((f) => f.id !== node.folderId && f.id !== ROOT_FOLDER_ID).map((f) => (
                <label key={f.id} className="flex items-center gap-2"><Checkbox checked={node.alsoIn.includes(f.id)} disabled={busy || (!node.alsoIn.includes(f.id) && node.alsoIn.length + (node.alsoInPaths?.length ?? 0) >= 10)}
                  onCheckedChange={(on) => onChange({ ...node, alsoIn: on === true ? [...node.alsoIn, f.id] : node.alsoIn.filter((x) => x !== f.id) })} />{f.path}</label>
              ))}
            </div>
          </details>
        ) : null}
      </> : null}
      {a3doc ? <p className="text-xs text-muted-foreground">This space sends what arrives on to a3doc, which can’t delete it. Put a “Wait for approval” step before this one until the flow does what you expect.</p> : null}
    </div>
  );
}
