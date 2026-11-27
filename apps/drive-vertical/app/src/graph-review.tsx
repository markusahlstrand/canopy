/**
 * Reviewing what the AI read from documents: people, companies and places, and what the
 * documents say about them. Every statement starts as a suggestion with the words it was read
 * from; a person accepts it (a fact) or rejects it (never asked again).
 *
 * Three places: a file's Details tab (what was read from this file), the space's Suggestions
 * (every open one, surest first, grouped by file; and the people and companies, where two found
 * to be one are merged), and an entity's card (what is known about it and who or what it
 * connects to).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Icon, Input, Tabs, TabsContent, TabsList, TabsTrigger,
} from '@canopy/ui';
import { nameKey, predicateById } from '@canopy/scope-drive/spec/model';
import {
  decideGraphClaims, extractEntities, fileGraph, graphEntities, graphEntity, graphSuggestions, mergeGraphEntities,
  type GraphClaim, type GraphConnection, type GraphEntity, type GraphEntitySummary,
} from './api';
import { EntityExtractionContext } from './ai-label';

export { EntityExtractionContext };

/** Open an entity's card from anywhere a claim is shown. */
const OpenEntityContext = createContext<(id: string) => void>(() => {});

type Node = GraphClaim['subject'];
const TYPE_LABEL: Record<GraphEntity['type'], string> = { Person: 'Person', Organization: 'Company', Place: 'Place' };

/** "Acme S.L. has VAT number ESB…": the predicate as words, from the shared vocabulary. */
export const predicateLabel = (id: string) => predicateById(id)?.label ?? id;

function NodeText({ node, selfFileId }: { node: Node; selfFileId?: string }) {
  const openEntity = useContext(OpenEntityContext);
  if (node.kind === 'entity') {
    return (
      <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" title={TYPE_LABEL[node.entity.type]}
        onClick={() => openEntity(node.entity.id)}>
        {node.entity.name}
      </button>
    );
  }
  if (node.kind === 'document') return <span className="font-medium">{node.fileId === selfFileId ? 'This document' : node.name}</span>;
  return <span className="font-medium">{node.display}</span>;
}

/** One statement, with the words it was read from and how sure the model was. */
export function ClaimLine({ claim, selfFileId, showFile = false }: { claim: GraphClaim; selfFileId?: string; showFile?: boolean }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <p className="leading-snug">
        <NodeText node={claim.subject} selfFileId={selfFileId} /> <span className="text-muted-foreground">{predicateLabel(claim.predicate)}</span>{' '}
        <NodeText node={claim.object} selfFileId={selfFileId} />
      </p>
      {claim.quote ? <p className="truncate text-xs italic text-muted-foreground" title={claim.quote}>“{claim.quote}”</p> : null}
      <p className="text-xs text-muted-foreground">
        {[
          claim.confidence !== null && claim.status === 'suggested' ? `${Math.round(claim.confidence * 100)}% sure` : null,
          claim.replaces.length ? `replaces ${claim.replaces.join(', ')}` : null,
          claim.decidedBy === 'auto:corroborates' ? 'also in another document' : null,
          showFile && claim.fileName ? `in ${claim.fileName}` : null,
        ].filter(Boolean).join(' · ')}
      </p>
    </div>
  );
}

function DecideButtons({ disabled, onAccept, onReject }: { disabled: boolean; onAccept: () => void; onReject: () => void }) {
  return (
    <div className="flex shrink-0 gap-1">
      <Button type="button" size="sm" variant="outline" disabled={disabled} aria-label="Accept" onClick={onAccept}>Accept</Button>
      <Button type="button" size="sm" variant="ghost" disabled={disabled} aria-label="Reject" onClick={onReject}>Reject</Button>
    </div>
  );
}

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message || fallback : String(e));

/** A file's Details: what was read from it, and the suggestions waiting on someone. */
export function FileGraphPanel({ fileId }: { fileId: string }) {
  const extraction = useContext(EntityExtractionContext);
  const [claims, setClaims] = useState<GraphClaim[] | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const got = await fileGraph(fileId);
      // An answer without a list (an older worker, a proxy page) reads as nothing read, not a crash.
      setClaims(Array.isArray(got?.claims) ? got.claims : []); setCanWrite(got?.canWrite === true); setError(null);
    } catch (e) {
      setError(message(e, 'Could not load what was read from this file.'));
    }
  }, [fileId]);
  useEffect(() => { setClaims(null); setNotice(null); void load(); }, [load]);

  const decide = async (ids: string[], decision: 'accept' | 'reject') => {
    setBusy(true); setError(null);
    try { setClaims((await decideGraphClaims(fileId, ids, decision)).claims); } catch (e) { setError(message(e, 'That did not work.')); } finally { setBusy(false); }
  };
  const find = async () => {
    setBusy(true); setError(null);
    try { await extractEntities({ fileId }); setNotice('Reading this document. Suggestions appear here in a minute or two.'); } catch (e) { setError(message(e, 'Could not start reading.')); } finally { setBusy(false); }
  };

  const open = claims?.filter((c) => c.status === 'suggested') ?? [];
  const known = claims?.filter((c) => c.status === 'accepted') ?? [];
  if (!extraction && claims !== null && !claims.length && !error) return null;

  return (
    <EntityCardHost>
      <section aria-label="People and companies" className="mt-4 space-y-2 border-t pt-3 text-sm">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">People and companies</h3>
          {extraction && canWrite ? (
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void find()}>
              <Icon name="sparkles" size={14} /> {claims?.length ? 'Read again' : 'Find people and companies'}
            </Button>
          ) : null}
        </div>
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        {notice ? <p role="status" className="text-xs text-muted-foreground">{notice}</p> : null}
        {claims === null && !error ? <p className="text-xs text-muted-foreground">Loading…</p> : null}
        {claims !== null && !claims.length ? <p className="text-xs text-muted-foreground">Nothing read from this document yet.</p> : null}
        {open.length ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium">Suggested ({open.length})</p>
              {canWrite && open.length > 1 ? (
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void decide(open.map((c) => c.id), 'accept')}>Accept all</Button>
              ) : null}
            </div>
            <ul className="space-y-2">
              {open.map((c) => (
                <li key={c.id} className="flex items-start justify-between gap-2 rounded border px-2 py-1.5">
                  <ClaimLine claim={c} selfFileId={fileId} />
                  {canWrite ? <DecideButtons disabled={busy} onAccept={() => void decide([c.id], 'accept')} onReject={() => void decide([c.id], 'reject')} /> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {known.length ? (
          <div className="space-y-1">
            <p className="text-xs font-medium">Known</p>
            <ul className="space-y-1.5">{known.map((c) => <li key={c.id}><ClaimLine claim={c} selfFileId={fileId} /></li>)}</ul>
          </div>
        ) : null}
      </section>
    </EntityCardHost>
  );
}

/** Lets anything below it open an entity's card; the card can walk on to the entities it connects to. */
export function EntityCardHost({ children }: { children: React.ReactNode }) {
  const [entityId, setEntityId] = useState<string | null>(null);
  return (
    <OpenEntityContext.Provider value={setEntityId}>
      {children}
      <EntityCard entityId={entityId} onOpen={setEntityId} onClose={() => setEntityId(null)} />
    </OpenEntityContext.Provider>
  );
}

function EntityCard({ entityId, onOpen, onClose }: { entityId: string | null; onOpen: (id: string) => void; onClose: () => void }) {
  const [view, setView] = useState<{ entity: GraphEntity; claims: GraphClaim[]; connections: GraphConnection[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!entityId) return;
    let current = true;
    setView(null); setError(null);
    graphEntity(entityId).then((got) => { if (current) setView(got); }).catch((e) => { if (current) setError(message(e, 'Could not load this entity.')); });
    return () => { current = false; };
  }, [entityId]);

  const facts = view?.claims.filter((c) => c.status === 'accepted' && c.subject.kind === 'entity' && c.subject.entity.id === view.entity.id) ?? [];
  const documents = view?.claims.filter((c) => c.subject.kind === 'document') ?? [];
  const pending = view?.claims.filter((c) => c.status === 'suggested' && c.subject.kind === 'entity') ?? [];

  return (
    <Dialog open={!!entityId} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[520px]">
        <DialogHeader className="px-5 pt-5">
          <DialogTitle>{view?.entity.name ?? 'Loading…'}</DialogTitle>
          <DialogDescription>
            {view ? `${TYPE_LABEL[view.entity.type]}${view.entity.status === 'suggested' ? ' · suggested, not confirmed yet' : ''}` : ' '}
          </DialogDescription>
        </DialogHeader>
        <OpenEntityContext.Provider value={onOpen}>
          <div className="min-h-0 space-y-4 overflow-y-auto px-5 py-4 text-sm">
            {error ? <p role="alert" className="text-destructive">{error}</p> : null}
            {view ? (
              <>
                <section className="space-y-1.5">
                  <h3 className="text-xs font-medium text-muted-foreground">Known</h3>
                  {facts.length ? <ul className="space-y-1.5">{facts.map((c) => <li key={c.id}><ClaimLine claim={c} showFile /></li>)}</ul>
                    : <p className="text-xs text-muted-foreground">Nothing confirmed yet.</p>}
                  {pending.length ? <p className="text-xs text-muted-foreground">{pending.length} more suggested, waiting in Suggestions.</p> : null}
                </section>
                <section className="space-y-1.5">
                  <h3 className="text-xs font-medium text-muted-foreground">In documents</h3>
                  {documents.length ? <ul className="space-y-1.5">{documents.map((c) => <li key={c.id}><ClaimLine claim={c} /></li>)}</ul>
                    : <p className="text-xs text-muted-foreground">No documents you can open.</p>}
                </section>
                <section className="space-y-1.5">
                  <h3 className="text-xs font-medium text-muted-foreground">Connected to</h3>
                  {view.connections.length ? (
                    <ul className="space-y-1">
                      {view.connections.map((c) => (
                        <li key={c.entity.id} className="flex items-baseline justify-between gap-2">
                          <button type="button" className="truncate font-medium text-primary underline-offset-2 hover:underline" onClick={() => onOpen(c.entity.id)}>{c.entity.name}</button>
                          <span className="shrink-0 text-xs text-muted-foreground">{c.via.map(predicateLabel).join(' → ')}</span>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="text-xs text-muted-foreground">No confirmed connections yet.</p>}
                </section>
              </>
            ) : !error ? <p role="status" className="text-xs text-muted-foreground">Loading…</p> : null}
          </div>
        </OpenEntityContext.Provider>
      </DialogContent>
    </Dialog>
  );
}

/** The space's review queue: open suggestions, and the people and companies to tidy by merging. */
export function SuggestionsDialog({ open, onOpenChange, onOpenFile }: { open: boolean; onOpenChange: (open: boolean) => void; onOpenFile?: (fileId: string) => void }) {
  const [tab, setTab] = useState<'statements' | 'entities'>('statements');
  const [claims, setClaims] = useState<GraphClaim[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setClaims((await graphSuggestions(100)).claims); setError(null); } catch (e) { setError(message(e, 'Could not load suggestions.')); }
  }, []);
  useEffect(() => { if (open) { setClaims(null); setTab('statements'); void load(); } }, [open, load]);

  // Grouped by file, files in the order their surest suggestion ranks.
  const groups = useMemo(() => {
    const byFile = new Map<string, GraphClaim[]>();
    for (const c of claims ?? []) byFile.set(c.fileId, [...(byFile.get(c.fileId) ?? []), c]);
    return [...byFile.entries()];
  }, [claims]);

  const decide = async (fileId: string, ids: string[], decision: 'accept' | 'reject') => {
    setBusy(true); setError(null);
    try {
      await decideGraphClaims(fileId, ids, decision);
      setClaims((now) => now?.filter((c) => !ids.includes(c.id)) ?? null);
    } catch (e) { setError(message(e, 'That did not work.')); } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[640px]">
        <DialogHeader className="px-5 pt-5">
          <DialogTitle>Suggestions</DialogTitle>
          <DialogDescription>People, companies and facts the AI read from this space’s documents. Accept what is right; rejected ones aren’t suggested again.</DialogDescription>
        </DialogHeader>
        <EntityCardHost>
          <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="flex min-h-0 flex-1 flex-col gap-0">
            <TabsList className="mx-5 mt-3">
              <TabsTrigger value="statements">Statements{claims?.length ? ` (${claims.length})` : ''}</TabsTrigger>
              <TabsTrigger value="entities">People and companies</TabsTrigger>
            </TabsList>
            <TabsContent value="statements" className="min-h-0 space-y-4 overflow-y-auto px-5 py-4 text-sm">
              {error ? <p role="alert" className="text-destructive">{error}</p> : null}
              {claims === null && !error ? <p role="status" className="text-xs text-muted-foreground">Loading…</p> : null}
              {claims?.length === 0 ? <p className="text-muted-foreground">Nothing waiting. New documents are read as they arrive, when “Suggest people and companies” is on in space settings.</p> : null}
              {groups.map(([fileId, list]) => (
                <section key={fileId} aria-label={list[0]!.fileName ?? 'Document'} className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    {onOpenFile ? (
                      <button type="button" className="truncate text-left text-xs font-medium hover:underline" onClick={() => onOpenFile(fileId)}>{list[0]!.fileName ?? 'Document'}</button>
                    ) : <span className="truncate text-xs font-medium">{list[0]!.fileName ?? 'Document'}</span>}
                    {list.length > 1 ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void decide(fileId, list.map((c) => c.id), 'accept')}>Accept all {list.length}</Button> : null}
                  </div>
                  <ul className="space-y-2">
                    {list.map((c) => (
                      <li key={c.id} className="flex items-start justify-between gap-2 rounded border px-2 py-1.5">
                        <ClaimLine claim={c} selfFileId={fileId} />
                        <DecideButtons disabled={busy} onAccept={() => void decide(fileId, [c.id], 'accept')} onReject={() => void decide(fileId, [c.id], 'reject')} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </TabsContent>
            <TabsContent value="entities" className="flex min-h-0 flex-col text-sm">
              {/* Statements name entities: after a merge they read the kept name. */}
              {open && tab === 'entities' ? <EntitiesPanel onMerged={() => void load()} /> : null}
            </TabsContent>
          </Tabs>
        </EntityCardHost>
      </DialogContent>
    </Dialog>
  );
}

const words = (e: GraphEntity) => nameKey(e.type, e.name).split(' ').filter(Boolean);

/**
 * Entities that are probably one, grouped: same kind, and every word of the shorter name is in
 * the longer one once case, accents and legal form are set aside ("Acme" and "ACME Servicios";
 * "Ana López" and "Ana López García"). A person needs two words to go on, since a first name alone
 * says little. Groups are joined through a shared longer name, so "Ana López" and "Ana García" land
 * together beside "Ana López García", who may go by either. A hint for a person to judge, never a
 * merge on its own.
 */
export function lookAlikes(list: readonly GraphEntitySummary[]): GraphEntitySummary[][] {
  const parent = list.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i]!)));
  const keys = list.map((s) => words(s.entity));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!.entity, b = list[j]!.entity;
      if (a.type !== b.type) continue;
      const [short, long] = keys[i]!.length <= keys[j]!.length ? [keys[i]!, keys[j]!] : [keys[j]!, keys[i]!];
      if (!short.length) continue;
      if (a.type === 'Person' ? short.length < 2 : !short.some((w) => w.length >= 3)) continue;
      const inLong = new Set(long);
      if (short.every((w) => inLong.has(w))) parent[root(j)] = root(i);
    }
  }
  const groups = new Map<number, GraphEntitySummary[]>();
  list.forEach((s, i) => groups.set(root(i), [...(groups.get(root(i)) ?? []), s]));
  return [...groups.values()].filter((g) => g.length > 1);
}

/** The one a merge keeps by default: a confirmed one, then the one most documents name. */
const preferred = (list: readonly GraphEntitySummary[]) =>
  [...list].sort((a, b) => Number(b.entity.status === 'accepted') - Number(a.entity.status === 'accepted') || b.documents - a.documents || a.entity.name.localeCompare(b.entity.name))[0];

function EntityRow({ item, selectable, checked, onCheck }: { item: GraphEntitySummary; selectable: boolean; checked: boolean; onCheck: (on: boolean) => void }) {
  const openEntity = useContext(OpenEntityContext);
  const { entity } = item;
  return (
    <li className="flex items-center gap-2 rounded px-1 py-1 hover:bg-muted/50">
      {selectable ? <Checkbox checked={checked} onCheckedChange={(v) => onCheck(v === true)} aria-label={`Select ${entity.name}`} /> : null}
      <button type="button" className="min-w-0 truncate text-left font-medium text-primary underline-offset-2 hover:underline" onClick={() => openEntity(entity.id)}>{entity.name}</button>
      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
        {[TYPE_LABEL[entity.type], `${item.documents} ${item.documents === 1 ? 'document' : 'documents'}`, entity.status === 'suggested' ? 'suggested' : null].filter(Boolean).join(' · ')}
      </span>
    </li>
  );
}

/** The space's people, companies and places: find the ones that are the same, and merge them. */
function EntitiesPanel({ onMerged }: { onMerged: () => void }) {
  const [items, setItems] = useState<GraphEntitySummary[] | null>(null);
  const [canMerge, setCanMerge] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [keepId, setKeepId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const got = await graphEntities();
      setItems(Array.isArray(got?.entities) ? got.entities : []); setCanMerge(got?.canMerge === true); setError(null);
    } catch (e) { setError(message(e, 'Could not load people and companies.')); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => {
    const q = nameKey('Person', query);
    return (items ?? []).filter((s) => !q || nameKey('Person', s.entity.name).includes(q));
  }, [items, query]);
  const alike = useMemo(() => lookAlikes(shown), [shown]);
  const rest = useMemo(() => {
    const grouped = new Set(alike.flat().map((s) => s.entity.id));
    return shown.filter((s) => !grouped.has(s.entity.id));
  }, [shown, alike]);

  const chosen = (items ?? []).filter((s) => selected.has(s.entity.id));
  const mixed = new Set(chosen.map((s) => s.entity.type)).size > 1;
  const toggle = (ids: string[], on: boolean) => setSelected((now) => {
    const next = new Set(now);
    for (const id of ids) { if (on) next.add(id); else next.delete(id); }
    return next;
  });
  const startMerge = (list: readonly GraphEntitySummary[]) => {
    setSelected(new Set(list.map((s) => s.entity.id)));
    setKeepId(preferred(list)?.entity.id ?? null);
    setConfirming(true); setError(null); setNotice(null);
  };

  const merge = async () => {
    const keep = chosen.find((s) => s.entity.id === keepId);
    if (!keep) return;
    setBusy(true); setError(null);
    try {
      const done = await mergeGraphEntities(keep.entity.id, chosen.filter((s) => s !== keep).map((s) => s.entity.id));
      setNotice(`Merged ${done.merged + 1} into “${done.entity.name}”.`);
      setConfirming(false); setSelected(new Set());
      await load();
      onMerged();
    } catch (e) { setError(message(e, 'Could not merge these.')); } finally { setBusy(false); }
  };

  const row = (item: GraphEntitySummary) => (
    <EntityRow key={item.entity.id} item={item} selectable={canMerge} checked={selected.has(item.entity.id)} onCheck={(on) => toggle([item.entity.id], on)} />
  );

  if (confirming) {
    return (
      <section aria-label="Merge" className="min-h-0 space-y-3 overflow-y-auto px-5 py-4">
        <h3 className="font-medium">Merge {chosen.length} into one</h3>
        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-xs text-muted-foreground">Keep the name</legend>
          {chosen.map((s) => (
            <label key={s.entity.id} className="flex items-center gap-2">
              <input type="radio" name="keep" checked={keepId === s.entity.id} onChange={() => setKeepId(s.entity.id)} />
              <span className="font-medium">{s.entity.name}</span>
              <span className="text-xs text-muted-foreground">{s.documents} {s.documents === 1 ? 'document' : 'documents'}</span>
            </label>
          ))}
        </fieldset>
        <p className="text-xs text-muted-foreground">Everything the documents say about the others moves to the one you keep, and their names find it when new documents mention them.</p>
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={() => { setConfirming(false); setError(null); }}>Cancel</Button>
          <Button type="button" disabled={busy || !keepId} onClick={() => void merge()}>Merge</Button>
        </div>
      </section>
    );
  }

  return (
    <>
      <div className="space-y-2 px-5 pt-4">
        <Input type="search" placeholder="Find a person or company" aria-label="Find a person or company" value={query} onChange={(e) => setQuery(e.target.value)} />
        {notice ? <p role="status" className="text-xs text-muted-foreground">{notice}</p> : null}
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-3">
        {items === null && !error ? <p role="status" className="text-xs text-muted-foreground">Loading…</p> : null}
        {items?.length === 0 ? <p className="text-muted-foreground">No people or companies yet. They appear here as documents are read.</p> : null}
        {items?.length && !shown.length ? <p className="text-muted-foreground">No one by that name.</p> : null}
        {alike.length ? (
          <section aria-label="Possibly the same" className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">Possibly the same</h3>
            {alike.map((group) => (
              <div key={group[0]!.entity.id} className="rounded border px-2 py-1.5">
                <ul>{group.map(row)}</ul>
                {canMerge ? (
                  <div className="flex justify-end">
                    <Button type="button" size="sm" variant="outline" onClick={() => startMerge(group)}>Merge these {group.length}…</Button>
                  </div>
                ) : null}
              </div>
            ))}
          </section>
        ) : null}
        {rest.length ? (
          <section aria-label={alike.length ? 'Everyone else' : 'Everyone'} className="space-y-1">
            {alike.length ? <h3 className="text-xs font-medium text-muted-foreground">Everyone else</h3> : null}
            <ul>{rest.map(row)}</ul>
          </section>
        ) : null}
      </div>
      {canMerge && chosen.length ? (
        <div className="flex items-center justify-between gap-2 border-t px-5 py-3">
          <span className="text-xs text-muted-foreground">
            {mixed ? 'Only the same kind can be merged: people with people, companies with companies.' : `${chosen.length} selected`}
          </span>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
            <Button type="button" size="sm" disabled={chosen.length < 2 || mixed} onClick={() => startMerge(chosen)}>Merge {chosen.length}…</Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
