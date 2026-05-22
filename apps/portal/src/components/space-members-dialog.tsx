import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Icon } from "@/lib/icons";
import { PersonAvatar } from "@/components/person-avatar";
import { addMember, listMembers, removeMember, type Member, type Role } from "@/lib/api";

const ROLES: Role[] = ["viewer", "editor", "owner"];

/** Manage who belongs to a space (a family/group). Members must have signed in once. */
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
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const m = await listMembers(spaceId);
        if (!cancelled) {
          setMembers(m);
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
      setMembers(await listMembers(spaceId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="truncate">Members of “{spaceName}”</DialogTitle>
        </DialogHeader>

        <form
          className="flex items-center gap-2"
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

        {error && <p className="text-[12.5px] text-destructive">{error}</p>}

        <div className="flex flex-col gap-1.5">
          {members.map((m) => (
            <div key={m.sub} className="flex items-center gap-2.5 rounded-lg border px-2.5 py-1.5">
              <PersonAvatar name={m.name ?? m.email ?? m.sub} size="md" />
              <span className="min-w-0 flex-1 truncate text-[13.5px]">{m.name ?? m.email ?? m.sub}</span>
              <span className="text-[12px] capitalize text-muted-foreground">{m.role}</span>
              {m.role !== "owner" && (
                <button
                  className="text-muted-foreground hover:text-destructive disabled:opacity-40"
                  disabled={busy}
                  onClick={() => void run(() => removeMember(spaceId, m.sub))}
                  aria-label="Remove member"
                >
                  <Icon name="x" size={15} />
                </button>
              )}
            </div>
          ))}
        </div>
        <p className="text-[12px] text-muted-foreground">
          People you add must have signed in once. Share a file by email to invite someone new.
        </p>
      </DialogContent>
    </Dialog>
  );
}
