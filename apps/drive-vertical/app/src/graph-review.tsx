/**
 * Reviewing what the AI read from documents: people, companies and places, and what the
 * documents say about them. Every statement starts as a suggestion with the words it was read
 * from; a person accepts it (a fact) or rejects it (never asked again).
 *
 * Three places: a file's Details tab (what was read from this file), the space's Suggestions
 * (every open one, surest first, grouped by file), and an entity's card (what is known about it
 * and who or what it connects to).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Icon } from '@canopy/ui';
import { predicateById } from '@canopy/scope-drive/spec/model';
import {
  decideGraphClaims, extractEntities, fileGraph, graphEntity, graphSuggestions,
  type GraphClaim, type GraphConnection, type GraphEntity,
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

/** The space's review queue: every open suggestion from files you can read, surest first, by file. */
export function SuggestionsDialog({ open, onOpenChange, onOpenFile }: { open: boolean; onOpenChange: (open: boolean) => void; onOpenFile?: (fileId: string) => void }) {
  const [claims, setClaims] = useState<GraphClaim[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setClaims((await graphSuggestions(100)).claims); setError(null); } catch (e) { setError(message(e, 'Could not load suggestions.')); }
  }, []);
  useEffect(() => { if (open) { setClaims(null); void load(); } }, [open, load]);

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
          <div className="min-h-0 space-y-4 overflow-y-auto px-5 py-4 text-sm">
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
          </div>
        </EntityCardHost>
      </DialogContent>
    </Dialog>
  );
}
