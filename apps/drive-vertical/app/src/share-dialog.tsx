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
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Icon, cn } from '@canopy/ui';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@canopy/ui';
import { latestOnly } from './reads';
import {
  listFolderShares,
  listPeople,
  shareFolder,
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

/** The same rule the topbar's avatar uses, so one person reads the same everywhere. */
function initialsOf(s: string): string {
  const parts = s.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
}

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
  const [people, setPeople] = useState<Person[] | null>(null);
  const [peopleFailed, setPeopleFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState('');
  const [level, setLevel] = useState<ShareLevel>('edit');
  const reads = useRef(latestOnly());

  const folderId = folder?.id ?? null;

  const load = useCallback(() => {
    if (!folderId) return;
    const ticket = reads.current.take();
    setError(null);
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
        setShares([]);
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

  useEffect(() => {
    if (!folderId) {
      // Anything in flight belongs to the folder being left — and this dialog is reopened
      // on a DIFFERENT folder, so a late answer would describe the wrong one.
      reads.current.invalidate();
      setShares(null);
      setPeople(null);
      setPeopleFailed(false);
      setError(null);
      setPicked('');
      setLevel('edit');
      return;
    }
    load();
  }, [folderId, load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Whoever is not already on the list, and not the person doing the sharing: they hold the
  // space, so sharing a folder with themselves would do nothing and say something false.
  const shareable = (people ?? []).filter(
    (person) => person.principal !== me && !(shares ?? []).some((s) => s.principal === person.principal),
  );

  return (
    <Dialog open={folder !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share “{folder?.name}”</DialogTitle>
          <DialogDescription>
            Everything inside this folder comes with it, however deep.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {/* Add somebody. A picker over the roster rather than a free-text field: a share
            names a principal, and an address nobody has signed in with names nothing. */}
        <div className="flex gap-2">
          <select
            aria-label="Person"
            value={picked}
            onChange={(e) => setPicked(e.currentTarget.value)}
            className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="">Choose a person…</option>
            {shareable.map((person) => (
              <option key={person.principal} value={person.principal}>
                {label(person)}
              </option>
            ))}
          </select>
          <select
            aria-label="Access"
            value={level}
            onChange={(e) => setLevel(e.currentTarget.value as ShareLevel)}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          >
            {LEVELS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
          <Button
            disabled={busy || !picked || !folderId}
            className="shrink-0"
            onClick={() => {
              const principal = picked;
              setPicked('');
              void act(() => shareFolder(folderId!, principal, level));
            }}
          >
            Share
          </Button>
        </div>

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
            <p className="text-sm text-muted-foreground">Loading…</p>
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
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                    {initialsOf(label(share))}
                  </span>
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
                          ? // Down to edit: take the manage key back, leave write.
                            unshareFolder(folderId!, share.principal).then(() =>
                              shareFolder(folderId!, share.principal, 'edit'),
                            )
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
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void act(() => unshareFolder(folderId!, share.principal))}
                  >
                    Remove
                  </Button>
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
