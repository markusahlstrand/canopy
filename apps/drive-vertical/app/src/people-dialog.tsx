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
import { useCallback, useEffect, useState } from 'react';
import { Button, Icon, Input, cn } from '@canopy/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@canopy/ui';
import { createInvite, listInvites, revokeInvite, type Invite } from './api';

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
  /**
   * The roles the SERVER says a teammate may be invited at.
   *
   * Not a constant here. The worker restricts this to one key, for a reason written in
   * `MEMBER_ROLE_KEY`, and the day that list grows this dialog needs a picker — taking
   * the answer from the server means it renders against what is actually allowed rather
   * than against what the client believed when it was written.
   */
  const [roles, setRoles] = useState<string[]>([]);
  const [email, setEmail] = useState('');
  const [minted, setMinted] = useState<Minted | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * This dialog's own error, not the shell's.
   *
   * Same reason the rail keeps its own: the drive's refresh clears the shell banner when
   * it succeeds, and it runs while this is open — so a failure here would survive or not
   * depending on which read answered last.
   */
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    listInvites()
      .then((answer) => {
        setInvites(answer.invites);
        setRoles(answer.roles);
      })
      .catch((e: unknown) => {
        setInvites([]);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(() => {
    if (!open) {
      // Nothing from the last visit survives: a copied link left on screen is a live
      // credential, and the list is cheap to read again.
      setMinted(null);
      setEmail('');
      setError(null);
      setInvites(null);
      setRoles([]);
      return;
    }
    load();
  }, [open, load]);

  const invite = async () => {
    const roleKey = roles[0];
    // No role means the list has not arrived (or the server offers none): there is nothing
    // honest to send, and the button is disabled for the same reason.
    if (!roleKey) return;
    setBusy(true);
    setError(null);
    try {
      const made = await createInvite(roleKey, email.trim() || undefined);
      setMinted({ principal: made.principal, email: made.email, acceptUrl: made.acceptUrl });
      setEmail('');
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (principal: string) => {
    setBusy(true);
    setError(null);
    try {
      await revokeInvite(principal);
      // The one on screen may be the one just withdrawn; its link is dead either way.
      setMinted((was) => (was?.principal === principal ? null : was));
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>People</DialogTitle>
          <DialogDescription>
            Invite someone into this space. They get a link, and become a member when they
            open it and sign in.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void invite();
          }}
        >
          <Input
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            placeholder="their email (optional — a note for you)"
            aria-label="Email"
            type="email"
            className="h-9"
          />
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
            Open invitations
          </h3>
          {invites === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : invites.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              None open. Accepted invitations are not listed here — this is what is still
              waiting.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {invites.map((row) => (
                <li
                  key={row.principal}
                  className={cn(
                    'flex items-center gap-2.5 rounded-md border border-border px-2.5 py-2 text-[13.5px]',
                  )}
                >
                  <Icon name="users" size={16} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">
                    {row.email ?? <span className="text-muted-foreground">no email noted</span>}
                  </span>
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    {row.roleKey}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void withdraw(row.principal)}
                  >
                    Withdraw
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
