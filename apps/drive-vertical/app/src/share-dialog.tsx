/**
 * Share a folder with someone (#79) — the surface the last three slices existed for.
 *
 * Two lists and one choice: who has access to this folder now, and who in the space could.
 * The people come from the roster (sign-ins), the access from the drive's own record of the
 * grants it made — because nothing can ask the kernel who holds a grant.
 *
 * The level is the interesting part. The kernel's keys are INDEPENDENT: `drive:manage` is
 * the authority to share a folder and delete what is in it, and does not include putting
 * anything in it. So "can edit and share" is two grants, and `api.ts` owns that mapping —
 * this dialog offers two levels and never mentions a key.
 *
 * Everything under the folder comes with it, which the dialog says out loud: a grant reaches
 * the subtree through the declared parent edge, and somebody who does not know that is
 * sharing more than they think.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Button, Icon, Input, PersonAvatar, cn } from '@canopy/ui';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@canopy/ui';
import { latestOnly } from './reads';
import { CopyFolderLink } from './copy-folder-link';
import { PeoplePicker, handlePeoplePickerEscape } from './people-picker';
import {
  listFolderShares,
  listPeople,
  shareFolder,
  shareFolderWithEmail,
  sharesByPerson,
  unshareFolder,
  type PersonShare,
  type Person,
  type ShareLevel,
} from './api';

const LEVELS: { value: ShareLevel; label: string; hint: string }[] = [
  { value: 'edit', label: 'Can edit', hint: 'Add, change and remove what is in it' },
  { value: 'manage', label: 'Can edit and share', hint: 'And give other people access' },
];

/** What to call somebody: their name, their address, or — honestly — their id. */
function label(person: { name: string | null; email: string | null; principal: string }) {
  return person.name ?? person.email ?? person.principal;
}

interface ShareDialogProps {
  /** The folder being shared, or null when the dialog is closed. */
  folder: { id: string; name: string } | null;
  onClose: () => void;
  /**
   * The caller's own principal, filtered out of the picker: they already hold the space, so
   * sharing a folder with themselves does nothing and says something false.
   *
   * Optional because `Me.principal` is — the shell only renders this screen for a signed-in
   * principal, but a type that admits `undefined` should not be coerced with an empty string
   * that happens to match nobody. Unknown means the filter is skipped, not that it matches.
   */
  me?: string;
}

export function ShareDialog({ folder, onClose, me }: ShareDialogProps) {
  const [shares, setShares] = useState<PersonShare[] | null>(null);
  const [sharesFailed, setSharesFailed] = useState(false);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [peopleFailed, setPeopleFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** What is in the picker's field — a name being matched, or an address being typed. */
  const [typed, setTyped] = useState('');
  /** A just-made invitation, held so its link can be copied. Shown once. */
  const [invited, setInvited] = useState<{ email: string; acceptUrl: string } | null>(null);
  /**
   * An address waiting to be confirmed before it becomes an invitation.
   *
   * Asked, not assumed, because an invitation is more than this folder: it makes the person a
   * MEMBER, and a member reads everything in the space. Sharing one folder with a stranger
   * must not quietly hand them the rest.
   */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [level, setLevel] = useState<ShareLevel>('edit');
  const reads = useRef(latestOnly());
  /** The folder on screen NOW, for actions that resolve after it changed. */
  const openFolder = useRef<string | null>(null);
  /** Distinguish a return to the same folder from the visit a mutation began in. */
  const visit = useRef(0);

  const folderId = folder?.id ?? null;
  openFolder.current = folderId;

  const load = useCallback(() => {
    if (!folderId) return;
    const ticket = reads.current.take();
    setError(null);
    setSharesFailed(false);
    setPeopleFailed(false);

    // Two reads, one ticket, landing independently — the shape the People dialog had to be
    // corrected into. The roster is the lesser of the two here as well: failing to read it
    // must not take away the ability to remove somebody's access.
    listFolderShares(folderId)
      .then((answer) => {
        if (!reads.current.current(ticket)) return;
        setShares(sharesByPerson(answer.shares));
      })
      .catch((e: unknown) => {
        if (!reads.current.current(ticket)) return;
        setShares(null);
        setSharesFailed(true);
        setError(e instanceof Error ? e.message : String(e));
      });

    listPeople()
      .then((answer) => {
        if (!reads.current.current(ticket)) return;
        setPeople(answer.people);
      })
      .catch(() => {
        if (!reads.current.current(ticket)) return;
        setPeople([]);
        setPeopleFailed(true);
      });
  }, [folderId]);

  useLayoutEffect(() => {
    // A folder switch must not briefly show the previous folder's grants or leave a
    // new dialog busy because an old mutation is still pending.
    visit.current++;
    reads.current.invalidate();
    setShares(null);
    setSharesFailed(false);
    setPeople(null);
    setPeopleFailed(false);
    setError(null);
    setBusy(false);
    setTyped('');
    setInvited(null);
    setConfirming(null);
    setLevel('edit');
    if (folderId) load();
  }, [folderId, load]);

  /**
   * A mutation, and nothing it says applies to a folder it did not start in.
   *
   * `act` closes over the `load` of the render it was called from, which closes over THAT
   * folder's id. A share removed on folder A, resolving after the dialog has been reopened on
   * folder B, would call A's `load` — which takes a fresh ticket and so passes the staleness
   * check, and writes A's access list under B's title. The ticket cannot catch this one: from
   * its point of view the read is the newest there is.
   *
   * Check both the folder and the visit: a return to A after visiting B must not let an
   * earlier A mutation reload grants or clear the new visit's busy state.
   */
  const act = async (fn: () => Promise<unknown>) => {
    const startedOn = folderId;
    const startedVisit = visit.current;
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (openFolder.current !== startedOn || visit.current !== startedVisit) return;
      load();
    } catch (e: unknown) {
      // The error too: a failure to change folder A is not something to report to somebody
      // now looking at folder B.
      if (openFolder.current !== startedOn || visit.current !== startedVisit) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (openFolder.current === startedOn && visit.current === startedVisit) setBusy(false);
    }
  };

  // Whoever is not already on the list, and not the person doing the sharing: they hold the
  // space, so sharing a folder with themselves would do nothing and say something false.
  const shareable = (people ?? []).filter(
    (person) => person.principal !== me && !(shares ?? []).some((s) => s.principal === person.principal),
  );

  return (
    <Dialog open={folder !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg" onEscapeKeyDown={handlePeoplePickerEscape}>
        <DialogHeader>
          <DialogTitle>Share “{folder?.name}”</DialogTitle>
          <DialogDescription>
            Everything inside this folder comes with it, however deep.
          </DialogDescription>
        </DialogHeader>

        {folder ? <CopyFolderLink key={folder.id} folderId={folder.id} /> : null}

        {error ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {/*
          The portal's shape, moved: type a name to pick somebody, or type an address nobody
          has seen and share with them anyway.

          The second half is what a bare `<select>` could not do, and what the portal did
          through an `email` subject its server resolved later. A grant here names a principal,
          so an address becomes an invitation first — `shareFolderWithEmail` mints the seat and
          grants the folder to it, and the person gets one link that makes them a member with
          the folder already theirs.
        */}
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const address = typed.trim();
            if (!address || !folderId) return;
            // An address somebody in the space already signed in with is that person, not a
            // stranger: inviting it would mint a second seat for them.
            const known = (people ?? []).find(
              (person) => person.email?.toLowerCase() === address.toLowerCase(),
            );
            if (known) {
              // Checked before the general case, whose message would be false here: the
              // caller may hold no share on this folder at all — they hold the space.
              if (me !== undefined && known.principal === me) {
                setError('That is you — you already have this whole space.');
                return;
              }
              if (!shareable.includes(known)) {
                setError(`${label(known)} already has access to this folder.`);
                return;
              }
              setTyped('');
              void act(() => shareFolder(folderId, known.principal, level));
              return;
            }
            setConfirming(address);
          }}
        >
          <PeoplePicker
            value={typed}
            onChange={(v) => {
              setTyped(v);
              // Editing the address withdraws the question about the old one.
              setConfirming(null);
            }}
            people={shareable}
            disabled={busy}
            placeholder="Add by name or email…"
            onPick={(person) => {
              setTyped('');
              void act(() => shareFolder(folderId!, person.principal, level));
            }}
          />
          <select
            aria-label="Access"
            value={level}
            onChange={(e) => setLevel(e.currentTarget.value as ShareLevel)}
            className="h-9 shrink-0 rounded-md border border-border bg-background px-2 text-sm"
          >
            {LEVELS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
          <Button type="submit" className="shrink-0" disabled={busy || !typed.trim()}>
            Share
          </Button>
        </form>

        {confirming ? (
          <div className="rounded-md border border-border bg-muted/40 p-3" role="alertdialog" aria-label="Invite to this space">
            <p className="text-[13px]">
              <span className="font-medium">{confirming}</span> is not in this space yet. Sharing
              invites them as a member of the whole space: they will be able to{' '}
              <span className="font-medium">read everything in it</span>, and{' '}
              {level === 'manage' ? 'edit and share' : 'edit'} “{folder?.name}”.
            </p>
            <div className="mt-2.5 flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busy || !folderId}
                onClick={() => {
                  const address = confirming;
                  const startedOn = folderId!;
                  const startedVisit = visit.current;
                  setConfirming(null);
                  setTyped('');
                  void act(async () => {
                    const made = await shareFolderWithEmail(startedOn, address, level);
                    // The same guard `act` applies after `fn`, needed here because this write
                    // happens INSIDE it: closed or moved on while the invite was in flight, and
                    // this link would reappear on whatever folder is open next.
                    if (openFolder.current === startedOn && visit.current === startedVisit) setInvited(made);
                  });
                }}
              >
                Invite and share
              </Button>
            </div>
          </div>
        ) : null}

        {/* The invitation's link, shown once — see the People dialog for why nothing is
            emailed and why an existing invitation's link cannot be shown again. */}
        {invited ? (
          <div className="rounded-md border border-border bg-muted/40 p-3">
            <p className="mb-2 text-[13px] font-medium">
              Invited {invited.email} — send them this link
            </p>
            <div className="flex gap-2">
              <Input
                readOnly
                value={invited.acceptUrl}
                aria-label="Invitation link"
                className="h-8 font-mono text-[11.5px]"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => void navigator.clipboard?.writeText(invited.acceptUrl).catch(() => undefined)}
              >
                Copy
              </Button>
            </div>
            <p className="mt-2 text-[11.5px] text-muted-foreground">
              They get this folder as soon as they open it. It is shown once.
            </p>
          </div>
        ) : null}

        {peopleFailed ? (
          <p className="text-[11.5px] text-muted-foreground">
            Couldn’t read who is in this space.{' '}
            <button onClick={load} className="underline hover:text-foreground">
              Try again
            </button>
          </p>
        ) : people !== null && shareable.length === 0 ? (
          <p className="text-[11.5px] text-muted-foreground">
            Everyone this drive has seen already has access. Invite someone from People first.
          </p>
        ) : null}

        <div>
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Has access
          </h3>
          {shares === null ? (
            sharesFailed ? <div className="space-y-2 text-sm">
              <p>Access could not be checked. Existing folder grants may still apply.</p>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={load}>Retry folder access</Button>
            </div> : <p className="text-sm text-muted-foreground">Loading…</p>
          ) : shares.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nobody yet. Members of this space can read it; nobody can change it.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {shares.map((share) => (
                <li
                  key={share.principal}
                  className={cn(
                    'flex items-center gap-2.5 rounded-md border border-border px-2.5 py-2 text-[13.5px]',
                  )}
                >
                  <PersonAvatar name={label(share)} size="md" />
                  <span className="min-w-0 flex-1 truncate">{label(share)}</span>
                  {/* Changing the level is a share at the new level: the lower one revokes
                      what the higher added, and the operation is idempotent either way. */}
                  <select
                    aria-label={`Access for ${label(share)}`}
                    value={share.level}
                    disabled={busy}
                    onChange={(e) =>
                      void act(() =>
                        e.currentTarget.value === 'edit'
                          ? // Down to edit: take the manage key back, and ONLY that.
                            // Removing everything and re-granting write is two operations
                            // whose second can fail, and then a downgrade has become a
                            // removal. This one cannot, because nothing is put back.
                            unshareFolder(folderId!, share.principal, ['drive:manage'])
                          : shareFolder(folderId!, share.principal, 'manage'),
                      )
                    }
                    className="h-8 shrink-0 rounded-md border border-border bg-background px-1.5 text-[12.5px]"
                  >
                    {LEVELS.map((l) => (
                      <option key={l.value} value={l.value}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                  {/* An X, as the portal had it: the row is already crowded with a level, and
                      taking a share back is not destructive the way removing a person is —
                      re-sharing restores exactly what was there. */}
                  <button
                    className="shrink-0 text-muted-foreground hover:text-destructive disabled:opacity-40"
                    disabled={busy}
                    aria-label={`Remove access for ${label(share)}`}
                    onClick={() => void act(() => unshareFolder(folderId!, share.principal))}
                  >
                    <Icon name="x" size={15} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[11.5px] text-muted-foreground">
            <Icon name="users" size={13} className="mr-1 inline align-[-2px]" />
            Everyone in this space already reads everything. Sharing is about who can change
            what.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
