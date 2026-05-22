import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Icon } from "@/lib/icons";
import { PersonAvatar } from "@/components/person-avatar";
import {
  addMember,
  createInvite,
  inviteUrl,
  listInvites,
  listMembers,
  removeMember,
  revokeInvite,
  type Member,
  type Role,
  type SpaceInvite,
} from "@/lib/api";

const ROLES: Role[] = ["viewer", "editor", "owner"];

/** Manage who belongs to a space (a family/group): add members, mint invite links. */
export function SpaceMembersDialog({
  spaceId,
  spaceName,
  open,
  onOpenChange,
}: {
  spaceId: string;
  spaceName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<SpaceInvite[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [linkRole, setLinkRole] = useState<Role>("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(token: string) {
    try {
      await navigator.clipboard.writeText(inviteUrl(token));
      setCopied(token);
      setTimeout(() => setCopied((c) => (c === token ? null : c)), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  }

  async function refresh() {
    const [m, inv] = await Promise.all([listMembers(spaceId), listInvites(spaceId)]);
    setMembers(m);
    setInvites(inv);
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const [m, inv] = await Promise.all([listMembers(spaceId), listInvites(spaceId)]);
        if (!cancelled) {
          setMembers(m);
          setInvites(inv);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, spaceId]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="truncate">Members of “{spaceName}”</DialogTitle>
        </DialogHeader>

        <form
          className="flex shrink-0 items-center gap-2"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            if (!email.trim()) return;
            void run(async () => {
              await addMember(spaceId, email.trim(), role);
              setEmail("");
            });
          }}
        >
          <Input
            type="email"
            placeholder="Add by email…"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="flex-1"
            autoComplete="off"
            data-bwignore
            data-1p-ignore
            data-lpignore="true"
          />
          <Select value={role} onValueChange={(v) => setRole(v as Role)}>
            <SelectTrigger className="w-[104px]" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLES.map((r) => (
                <SelectItem key={r} value={r} className="capitalize">
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="submit" size="sm" disabled={busy || !email.trim()}>
            Add
          </Button>
        </form>

        {/* Invite links: one-time tokens. Whoever opens one signs in (with any
            account) and joins at the link's role — no email needed up front. */}
        <div className="flex shrink-0 flex-col gap-1.5 rounded-lg bg-muted/60 p-2.5">
          <div className="flex items-center gap-2">
            <Icon name="link" size={14} className="text-muted-foreground" />
            <span className="flex-1 text-[12.5px] font-medium">Invite link</span>
            <Select value={linkRole} onValueChange={(v) => setLinkRole(v as Role)}>
              <SelectTrigger className="w-[100px]" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r} className="capitalize">
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void run(async () => void (await createInvite(spaceId, linkRole)))}
            >
              Create
            </Button>
          </div>
          {invites.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">
              No active links. Create one to invite someone — it works once, then expires.
            </p>
          ) : (
            invites.map((inv) => (
              <div key={inv.token} className="flex items-center gap-2 rounded-md bg-background px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground">
                  {inviteUrl(inv.token)}
                </span>
                <span className="shrink-0 text-[11px] capitalize text-muted-foreground">{inv.role}</span>
                <Button variant="ghost" size="sm" className="shrink-0" onClick={() => void copy(inv.token)}>
                  {copied === inv.token ? "Copied" : "Copy"}
                </Button>
                <button
                  className="shrink-0 text-muted-foreground hover:text-destructive disabled:opacity-40"
                  disabled={busy}
                  onClick={() => void run(() => revokeInvite(spaceId, inv.token))}
                  aria-label="Revoke link"
                >
                  <Icon name="x" size={15} />
                </button>
              </div>
            ))
          )}
        </div>

        {error && <p className="shrink-0 text-[12.5px] text-destructive">{error}</p>}

        <div className="-mx-1 flex flex-1 flex-col gap-1.5 overflow-y-auto px-1">
          {members.map((m) => (
            <div key={m.sub || m.email} className="flex items-center gap-2.5 rounded-lg border px-2.5 py-1.5">
              <PersonAvatar name={m.name ?? m.email ?? m.sub} size="md" />
              <span className="min-w-0 flex-1 truncate text-[13.5px]">
                {m.name ?? m.email ?? m.sub}
                {m.pending && <span className="ml-1.5 text-[11px] text-muted-foreground">· invited</span>}
              </span>
              <span className="text-[12px] capitalize text-muted-foreground">{m.role}</span>
              {m.role !== "owner" && (
                <button
                  className="text-muted-foreground hover:text-destructive disabled:opacity-40"
                  disabled={busy}
                  onClick={() => void run(() => removeMember(spaceId, m.sub || m.email || ""))}
                  aria-label="Remove member"
                >
                  <Icon name="x" size={15} />
                </button>
              )}
            </div>
          ))}
        </div>
        <p className="shrink-0 text-[12px] text-muted-foreground">
          Add someone by email, or send a one-time invite link. Either way they get access the moment
          they sign in — with whichever account they choose.
        </p>
      </DialogContent>
    </Dialog>
  );
}
