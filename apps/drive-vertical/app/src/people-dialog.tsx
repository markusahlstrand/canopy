/**
 * Who is in this space, and how someone else gets in (#79).
 *
 * The first surface in this drive that is about PEOPLE rather than files, and the
 * prerequisite for sharing anything: a folder cannot be shared with somebody who has no
 * way to be in the space.
 *
 * What it deliberately does not claim: this is a list of open INVITATIONS, not a roster.
 * The directory records an invitation until it is accepted, and an accepted one stops
 * being a row here — so "everyone in this space" is not a question this can answer yet,
 * and the empty state says so rather than implying you are alone.
 *
 * Nothing is emailed. The platform verifies no address on this path, so an invitation IS
 * its link: the owner copies it and passes it on however they already talk to the person.
 * The email field is a note on the row so an owner can tell two invitations apart.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Button, Icon, Input, PersonAvatar, cn } from '@canopy/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@canopy/ui';
import { latestOnly } from './reads';
import { PeoplePicker, handlePeoplePickerEscape } from './people-picker';
import {
  createInvite,
  listInvites,
  listPeople,
  removePerson,
  revokeInvite,
  type Invite,
  type Person,
} from './api';

interface PeopleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** A just-minted invitation, held so its link can be copied. It is shown once. */
interface Minted {
  principal: string;
  email: string | null;
  acceptUrl: string;
}

export function PeopleDialog({ open, onOpenChange }: PeopleDialogProps) {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [people, setPeople] = useState<Person[] | null>(null);
  /** The roster read failed. Its own state, because it must not disable inviting. */
  const [peopleFailed, setPeopleFailed] = useState(false);
  /**
   * The roles the SERVER says a teammate may be invited at.
   *
   * Not a constant here. The worker restricts this to one key, for a reason written in
   * `MEMBER_ROLE_KEY`, and the day that list grows this dialog needs a picker — taking
   * the answer from the server means it renders against what is actually allowed rather
   * than against what the client believed when it was written.
   */
  const [roles, setRoles] = useState<string[]>([]);
  const [selectedRole, setSelectedRole] = useState('member');
  const offeredRoles=roles.filter(role=>role!=='member'||!roles.includes('viewer'));
  const inviteRole = offeredRoles.includes(selectedRole) ? selectedRole : offeredRoles[0];
  const [email, setEmail] = useState('');
  const [minted, setMinted] = useState<Minted | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Who has been asked about, not yet confirmed.
   *
   * Removal is not undoable — the grants are gone and re-inviting does not bring them back —
   * so it takes two clicks. In the row rather than in a second dialog: `confirm()` is blocked
   * in some embedded webviews and untestable in all of them, and a dialog on top of a dialog
   * is worse than a button that changes its mind.
   */
  const [confirming, setConfirming] = useState<string | null>(null);
  /**
   * This dialog's own error, not the shell's.
   *
   * Same reason the rail keeps its own: the drive's refresh clears the shell banner when
   * it succeeds, and it runs while this is open — so a failure here would survive or not
   * depending on which read answered last.
   */
  const [error, setError] = useState<string | null>(null);
  /**
   * The same ticket the drive screen uses, for the same reason.
   *
   * This component stays mounted while `open` changes, and every mutation triggers
   * another read — so a read from before the dialog closed can repopulate the list it
   * cleared, and two reads started by two withdrawals can land out of order and leave the
   * older answer on screen. Closing invalidates; only the newest read may write.
   */
  const reads = useRef(latestOnly());
  const visit = useRef(0);
  // Read by mutations that finish later: the `open` they closed over is from when they started.
  const shown = useRef(open);

  /**
   * One list of people, which is the portal's shape and the better one: an unaccepted
   * invitation is a PERSON who has not arrived yet, not a separate table of paperwork.
   *
   * The two reads stay separate (they fail separately, see `load`) and are merged here.
   * Invitations whose principal already appears in the roster are dropped: that is somebody
   * who accepted and signed in, and the invite row can outlive the acceptance by a moment.
   */
  const roster =
    people === null && invites === null
      ? null
      : [
          ...(people ?? []).map((p) => ({
            principal: p.principal,
            name: p.name,
            email: p.email,
            label: p.name ?? p.email ?? p.principal,
            pending: false, roleKey: null,
          })),
          ...(invites ?? [])
            .filter((i) => !(people ?? []).some((p) => p.principal === i.principal))
            .map((i) => ({
              principal: i.principal,
              name: null,
              email: i.email,
              label: i.email ?? i.principal,
              pending: true, roleKey: i.roleKey,
            })),
        ];

  const load = useCallback(() => {
    const ticket = reads.current.take();
    setError(null);
    setPeopleFailed(false);

    /**
     * Two reads, ONE ticket, and no `Promise.all`.
     *
     * The ticket is shared because they are one view and a stale answer must not land half
     * of it. But awaiting them together made the lesser read able to break the greater one:
     * if the roster failed, a perfectly good invitation list was discarded with it and
     * `roles` stayed empty — which disables the Invite button, so a failure to read who has
     * signed in took away the one thing this dialog exists to do.
     *
     * So each lands on its own, and each reports its own failure where it happened.
     */
    listInvites()
      .then((open) => {
        if (!reads.current.current(ticket)) return;
        setInvites(open.invites);
        setRoles(open.roles);
      })
      .catch((e: unknown) => {
        // A stale FAILURE is as misleading as a stale answer — it belongs to a dialog
        // that is no longer open, or to a read something newer has already corrected.
        if (!reads.current.current(ticket)) return;
        setInvites([]);
        setError(e instanceof Error ? e.message : String(e));
      });

    listPeople()
      .then((seen) => {
        if (!reads.current.current(ticket)) return;
        setPeople(seen.people);
      })
      .catch(() => {
        // Not the banner: this failure is about one list, and the banner is where the
        // failure of an ACTION goes. Said in the section it belongs to, with a retry.
        if (!reads.current.current(ticket)) return;
        setPeople([]);
        setPeopleFailed(true);
      });
  }, []);

  useLayoutEffect(() => {
    visit.current++;
    shown.current = open;
    setBusy(false);
    if (!open) {
      // Nothing from the last visit survives: a copied link left on screen is a live
      // credential, and the list is cheap to read again. Anything still in flight belongs
      // to the visit being ended and may not write to the next one.
      reads.current.invalidate();
      setMinted(null);
      setEmail('');
      setError(null);
      setInvites(null);
      setPeople(null);
      setPeopleFailed(false);
      setConfirming(null);
      setRoles([]);
      return;
    }
    load();
    return () => { visit.current++; shown.current = false; reads.current.invalidate(); };
  }, [open, load]);

  const invite = async () => {
    const roleKey = inviteRole;
    // No role means the list has not arrived (or the server offers none): there is nothing
    // honest to send, and the button is disabled for the same reason.
    if (!roleKey) return;
    const ticket = visit.current;
    setBusy(true);
    setError(null);
    try {
      const made = await createInvite(roleKey, email.trim() || undefined);
      // A later visit's read was sent before this landed, so it still needs refreshing —
      // `reads` orders that. The link itself belongs to the visit that asked for it.
      if (shown.current) load();
      if (visit.current !== ticket) return;
      setMinted({ principal: made.principal, email: made.email, acceptUrl: made.acceptUrl });
      setEmail('');
    } catch (e: unknown) {
      if (visit.current === ticket) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (visit.current === ticket) setBusy(false);
    }
  };

  const remove = async (principal: string) => {
    const ticket = visit.current;
    setBusy(true);
    setError(null);
    try {
      await removePerson(principal);
      if (shown.current) load();
      if (visit.current !== ticket) return;
      setConfirming(null);
    } catch (e: unknown) {
      if (visit.current === ticket) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (visit.current === ticket) setBusy(false);
    }
  };

  const withdraw = async (principal: string) => {
    const ticket = visit.current;
    setBusy(true);
    setError(null);
    try {
      await revokeInvite(principal);
      if (shown.current) load();
      if (visit.current !== ticket) return;
      // The one on screen may be the one just withdrawn; its link is dead either way.
      setMinted((was) => (was?.principal === principal ? null : was));
    } catch (e: unknown) {
      if (visit.current === ticket) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (visit.current === ticket) setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" onEscapeKeyDown={handlePeoplePickerEscape}>
        <DialogHeader>
          <DialogTitle>People</DialogTitle>
          <DialogDescription>
            Invite someone into this space. Choose whether they can read or edit its files. They get a link, and become a member when they
            open it and sign in.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {/*
          The portal's picker, moved — and here it earns its place differently than in the
          share dialog: picking somebody already in the space is NOT an action (they are already
          a member), so a match is a warning rather than a shortcut. What it prevents is
          inviting an address that is already here, which the portal's `exclude` did too.
        */}
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void invite();
          }}
        >
          <PeoplePicker
            value={email}
            onChange={setEmail}
            people={people ?? []}
            disabled={busy}
            label="Email"
            placeholder="their email — they get a link"
            // A match means "already here", so choosing one says so instead of inviting them
            // again into a space they are in.
            onPick={(person) => {
              setEmail('');
              setError(`${person.name ?? person.email ?? person.principal} is already in this space.`);
            }}
          />
          <label className="text-xs">Role<select aria-label="Invitation role" disabled={busy || roles.length === 0} value={inviteRole ?? ''} onChange={event => setSelectedRole(event.target.value)}>{offeredRoles.map(role => <option key={role} value={role}>{role === 'viewer' || role === 'member' ? 'Viewer — read files' : role === 'editor' ? 'Editor — read and edit files' : role === 'owner' ? 'Owner — manage this space' : role}</option>)}</select></label>
          <Button type="submit" disabled={busy || roles.length === 0} className="shrink-0 gap-1.5">
            <Icon name="plus" size={16} />
            Invite
          </Button>
        </form>

        {/* The link, shown once. A copy button rather than a mailto: nothing here sends
            mail, and offering a link that looks like it does would be a lie. */}
        {minted ? (
          <div className="rounded-md border border-border bg-muted/40 p-3">
            <p className="mb-2 text-[13px] font-medium">
              Invitation ready{minted.email ? ` for ${minted.email}` : ''} — send them this link
            </p>
            <div className="flex gap-2">
              <Input readOnly value={minted.acceptUrl} aria-label="Invitation link" className="h-8 font-mono text-[11.5px]" />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => {
                  // Clipboard access can be refused (permissions, an insecure origin) and
                  // the field is selectable either way, so a failure is not worth an error.
                  void navigator.clipboard?.writeText(minted.acceptUrl).catch(() => undefined);
                }}
              >
                Copy
              </Button>
            </div>
            <p className="mt-2 text-[11.5px] text-muted-foreground">
              It is shown once. Withdraw the invitation below if it goes astray.
            </p>
          </div>
        ) : null}

        <div>
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            People
          </h3>
          {/*
            The failure sits BESIDE the list, not instead of it.
            
            Replacing the list with this message would hide invitations that loaded perfectly
            well — which is the same mistake as bundling the two reads, made again in the
            rendering instead of the fetching.
          */}
          {peopleFailed ? (
            <p className="mb-2 text-[12.5px] text-muted-foreground">
              Couldn’t read who is in this space — only invitations are listed.{' '}
              <button onClick={load} className="underline hover:text-foreground">
                Try again
              </button>
            </p>
          ) : null}
          {roster === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : roster.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nobody here but you.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {roster.map((row) => (
                <li
                  key={row.principal}
                  className={cn(
                    'flex items-center gap-2.5 rounded-md border border-border px-2.5 py-2 text-[13.5px]',
                  )}
                >
                  <PersonAvatar name={row.label} size="md" />
                  <span className="min-w-0 flex-1 truncate">
                    {row.name ?? row.email ?? (
                      // A principal and nothing else is what an issuer releasing neither claim
                      // looks like. Showing the id is more honest than a blank.
                      <span className="font-mono text-[11.5px] text-muted-foreground">
                        {row.principal}
                      </span>
                    )}
                    {row.pending && (
                      <span className="ml-1.5 text-[11px] text-muted-foreground">· invited as {row.roleKey}</span>
                    )}
                  </span>
                  {row.name && row.email && (
                    <span className="hidden truncate text-[11.5px] text-muted-foreground sm:block">
                      {row.email}
                    </span>
                  )}

                  {/* An invitation is withdrawn on one click: nobody has used it, and
                      re-inviting costs a click. A PERSON is removed on two — their access and
                      everything shared with them goes, and re-inviting does not bring it back. */}
                  {row.pending ? (
                    <button
                      className="shrink-0 text-muted-foreground hover:text-destructive disabled:opacity-40"
                      disabled={busy}
                      aria-label={`Withdraw the invitation for ${row.label}`}
                      onClick={() => void withdraw(row.principal)}
                    >
                      <Icon name="x" size={15} />
                    </button>
                  ) : confirming === row.principal ? (
                    <>
                      <span className="shrink-0 text-[11.5px] text-muted-foreground">
                        Removes their access
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void remove(row.principal)}
                      >
                        Confirm
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setConfirming(null)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <button
                      className="shrink-0 text-muted-foreground hover:text-destructive disabled:opacity-40"
                      disabled={busy}
                      aria-label={`Remove ${row.label}`}
                      onClick={() => setConfirming(row.principal)}
                    >
                      <Icon name="x" size={15} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* Two things this list still cannot say, both worth saying instead of implying:
              somebody who has never opened the drive is missing from it (it is built from
              sign-ins), and a member's ROLE is not here — the kernel holds roles, and the
              roster does not read them, so an owner and a member look alike. */}
          <p className="mt-3 text-[11.5px] text-muted-foreground">
            Invited people appear here until they open their link. Somebody who has never opened
            this drive is not listed at all. Removing somebody takes away their access to this
            space and everything shared with them in it.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
