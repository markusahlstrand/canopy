import { useUnsavedDraft } from './drafts';
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  useUnsavedDraft(draft.length > 0);
  const ordered = (rows: FileComment[]) => rows.sort((a, b) => a.id.localeCompare(b.id));
  const message = (e: unknown) => e instanceof Error ? e.message || 'Could not update comments.' : String(e);

  const load = async (more = false) => {
    const ticket = guard.take();
    setBusy(true);
    setError(null);
    try {
      const page = await commentPage(fileId, more ? next : null);
      if (!guard.current(ticket)) return;
      setComments(rows => ordered(more ? appendRows(rows ?? [], page.entries) : page.entries));
      setNext(page.next);
    } catch (e: unknown) {
      if (guard.current(ticket)) setError(message(e));
    } finally {
      if (guard.current(ticket)) setBusy(false);
    }
  };
  useEffect(() => {
    setComments(null);
    setNext(null);
    setDraft('');
    setConfirmDelete(null);
    void load();
    return () => guard.invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  const post = async () => {
    if (busy || !draft.trim() || !comments) return;
    const ticket = guard.take();
    setBusy(true);
    setError(null);
    try {
      const comment = await postComment(fileId, draft);
      if (!guard.current(ticket)) return;
      setComments(rows => ordered(appendRows(rows ?? [], [comment])));
      setDraft('');
    } catch (e: unknown) {
      if (guard.current(ticket)) setError(message(e));
    } finally {
      if (guard.current(ticket)) setBusy(false);
    }
  };
  const remove = async (id: string) => {
    const ticket = guard.take();
    setBusy(true);
    setError(null);
    try {
      await deleteComment(fileId, id);
      if (!guard.current(ticket)) return;
      setComments(rows => rows?.filter(row => row.id !== id) ?? null);
      setConfirmDelete(null);
    } catch (e: unknown) {
      if (guard.current(ticket)) setError(message(e));
    } finally {
      if (guard.current(ticket)) setBusy(false);
    }
  };

  return <div className="space-y-3 text-sm">
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>Refresh comments</Button>
    {error ? <p role="alert">{error}</p> : null}
    {comments === null ? <p>{busy ? 'Loading comments…' : 'Could not load comments. Refresh to retry.'}</p> : <>
      {comments.length === 0 ? <p>No comments yet.</p> : <ul className="space-y-3">
        {comments.map(comment => <li key={comment.id} className="space-y-1 border-b border-border pb-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{comment.authorLabel}</span><time dateTime={comment.created_at}>{new Date(comment.created_at).toLocaleString()}</time>
          </div>
          <p className="whitespace-pre-wrap break-words">{comment.body}</p>
          {comment.canDelete ? confirmDelete === comment.id ? <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void remove(comment.id)}>Confirm delete</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(null)}>Cancel</Button>
          </div> : <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(comment.id)}>Delete comment</Button> : null}
        </li>)}
      </ul>}
      {next ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void load(true)}>Load more comments</Button> : null}
      <form className="space-y-2" onSubmit={event => { event.preventDefault(); void post(); }}>
        <label className="block space-y-1"><span>New comment</span>
          <textarea className="w-full rounded border border-border bg-background p-2" rows={3} maxLength={10000}
            value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} />
        </label>
        <Button type="submit" disabled={busy || !draft.trim()}>Post comment</Button>
      </form>
    </>}
  </div>;
}
