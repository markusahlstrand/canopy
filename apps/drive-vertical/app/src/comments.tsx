import { watchDriveChanges } from './live-updates';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@canopy/ui';
import { appendRows, commentPage, postComment, deleteComment, type FileComment } from './api';
import { latestOnly } from './reads';

/** Plain text only. Every reader may comment; moderation rights come from the API. */
export function CommentsPanel({ fileId }: { fileId: string }) {
  const guard = useRef(latestOnly()).current;
  const [comments, setComments] = useState<FileComment[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const localPosts = useRef<FileComment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const working = useRef(false);
  const pending = useRef(false);
  const pages = useRef(1);
  const liveRefresh = useRef<() => void>(() => {});
  const ordered = (rows: FileComment[]) => rows.sort((a, b) => a.id.localeCompare(b.id));
  const message = (e: unknown) => e instanceof Error ? e.message || 'Could not update comments.' : String(e);

  const load = async (more = false, replay = false) => {
    if (working.current) return;
    working.current = true;
    const ticket = guard.take();
    if (replay) setRefreshing(true);
    else { setBusy(true); setError(null); }
    try {
      const page = await commentPage(fileId, more ? next : null);
      let count = 1;
      if (replay) {
        const target = pages.current;
        const visited = new Set<string>();
        while (count < target && page.next) {
          if (visited.has(page.next)) throw new Error('Comment pages did not advance.');
          visited.add(page.next);
          const older = await commentPage(fileId, page.next);
          if (!guard.current(ticket)) return;
          page.entries = appendRows(page.entries, older.entries);
          page.next = older.next;
          count++;
        }
      }
      if (!guard.current(ticket)) return;
      const last = page.entries.at(-1)?.id ?? '';
      localPosts.current = localPosts.current.filter(row => !!page.next && row.id > last);
      setComments(rows => ordered(appendRows(more ? appendRows(rows ?? [], page.entries) : page.entries, localPosts.current)));
      setNext(page.next);
      pages.current = more ? pages.current + 1 : count;
    } catch (e: unknown) {
      if (guard.current(ticket) && !replay) setError(message(e));
    } finally {
      if (guard.current(ticket)) { working.current = false; if (replay) setRefreshing(false); else setBusy(false); }
    }
  };
  useEffect(() => {
    working.current = false;
    pending.current = false;
    pages.current = 1;
    localPosts.current = [];
    setRefreshing(false);
    setComments(null);
    setNext(null);
    setDraft('');
    setConfirmDelete(null);
    void load();
    return () => guard.invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  liveRefresh.current = () => { void load(false, true); };
  useEffect(() => {
    const stop = watchDriveChanges(() => {
      if (working.current) pending.current = true;
      else liveRefresh.current();
    }, { entityType: 'file', entityId: fileId });
    return () => { pending.current = false; stop(); };
  }, [fileId]);
  useEffect(() => {
    if (!working.current && pending.current) { pending.current = false; liveRefresh.current(); }
  }, [busy, refreshing]);

  const post = async () => {
    if (working.current || !draft.trim() || !comments) return;
    working.current = true;
    const ticket = guard.take();
    setBusy(true);
    setError(null);
    try {
      const comment = await postComment(fileId, draft);
      if (!guard.current(ticket)) return;
      localPosts.current.push(comment);
      setComments(rows => ordered(appendRows(rows ?? [], [comment])));
      setDraft('');
    } catch (e: unknown) {
      if (guard.current(ticket)) setError(message(e));
    } finally {
      if (guard.current(ticket)) { working.current = false; setBusy(false); }
    }
  };
  const remove = async (id: string) => {
    if (working.current) return;
    working.current = true;
    const ticket = guard.take();
    setBusy(true);
    setError(null);
    try {
      await deleteComment(fileId, id);
      if (!guard.current(ticket)) return;
      localPosts.current = localPosts.current.filter(row => row.id !== id);
      setComments(rows => rows?.filter(row => row.id !== id) ?? null);
      setConfirmDelete(null);
    } catch (e: unknown) {
      if (guard.current(ticket)) setError(message(e));
    } finally {
      if (guard.current(ticket)) { working.current = false; setBusy(false); }
    }
  };

  return <div className="space-y-3 text-sm">
    <Button size="sm" variant="outline" disabled={busy || refreshing} onClick={() => void load()}>Refresh comments</Button>
    {error ? <p role="alert">{error}</p> : null}
    {comments === null ? <p>{busy ? 'Loading comments…' : 'Could not load comments. Refresh to retry.'}</p> : <>
      {comments.length === 0 ? <p>No comments yet.</p> : <ul className="space-y-3">
        {comments.map(comment => <li key={comment.id} className="space-y-1 border-b border-border pb-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{comment.authorLabel}</span><time dateTime={comment.created_at}>{new Date(comment.created_at).toLocaleString()}</time>
          </div>
          <p className="whitespace-pre-wrap break-words">{comment.body}</p>
          {comment.canDelete ? confirmDelete === comment.id ? <div className="flex gap-2">
            <Button size="sm" disabled={busy || refreshing} onClick={() => void remove(comment.id)}>Confirm delete</Button>
            <Button size="sm" variant="ghost" disabled={busy || refreshing} onClick={() => setConfirmDelete(null)}>Cancel</Button>
          </div> : <Button size="sm" variant="ghost" disabled={busy || refreshing} onClick={() => setConfirmDelete(comment.id)}>Delete comment</Button> : null}
        </li>)}
      </ul>}
      {next ? <Button size="sm" variant="outline" disabled={busy || refreshing} onClick={() => void load(true)}>Load more comments</Button> : null}
      <form className="space-y-2" onSubmit={event => { event.preventDefault(); void post(); }}>
        <label className="block space-y-1"><span>New comment</span>
          <textarea className="w-full rounded border border-border bg-background p-2" rows={3} maxLength={10000}
            value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} />
        </label>
        <Button type="submit" disabled={busy || refreshing || !draft.trim()}>Post comment</Button>
      </form>
    </>}
  </div>;
}
