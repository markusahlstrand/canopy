import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Icon } from "@/lib/icons";
import { PersonAvatar } from "@/components/person-avatar";
import { listGrants, listSpaces, shareFile, unshareFile, type Grant, type Role, type SpaceView } from "@/lib/api";

const ROLES: Role[] = ["viewer", "editor", "owner"];

/** Per-file Share dialog: shows current grants, adds people by email or whole spaces. */
export function ShareDialog({
  fileId,
  fileName,
  open,
  onOpenChange,
}: {
  fileId: string;
  fileName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [spaces, setSpaces] = useState<SpaceView[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const spaceName = (id: string) => spaces.find((s) => s.id === id)?.name ?? "Space";

  async function refresh() {
    try {
      setGrants(await listGrants(fileId));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const [g, s] = await Promise.all([listGrants(fileId), listSpaces()]);
        if (cancelled) return;
        setGrants(g);
        setSpaces(s.filter((x) => x.kind === "group"));
        setError(null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, fileId]);

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

  function label(g: Grant): string {
    if (g.subjectType === "email") return g.subjectId;
    if (g.subjectType === "space") return spaceName(g.subjectId);
    return g.subjectId; // a user sub
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="truncate">Share “{fileName}”</DialogTitle>
        </DialogHeader>

        {/* add a person by email */}
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!email.trim()) return;
            void run(async () => {
              await shareFile(fileId, { subjectType: "email", subjectId: email.trim() }, role);
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
          <RoleSelect value={role} onChange={setRole} />
          <Button type="submit" size="sm" disabled={busy || !email.trim()}>
            Share
          </Button>
        </form>

        {/* share with a whole space */}
        {spaces.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {spaces.map((s) => (
              <Button
                key={s.id}
                variant="outline"
                size="sm"
                disabled={busy}
                className="gap-1.5"
                onClick={() => void run(() => shareFile(fileId, { subjectType: "space", subjectId: s.id }, role))}
              >
                <Icon name="users" size={13} /> {s.name}
              </Button>
            ))}
          </div>
        )}

        {error && <p className="text-[12.5px] text-destructive">{error}</p>}

        {/* who has access */}
        <div className="mt-1">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            People with access
          </div>
          <div className="flex flex-col gap-1.5">
            {grants.length === 0 && <p className="text-[13px] text-muted-foreground">Only you.</p>}
            {grants.map((g, i) => (
              <div key={i} className="flex items-center gap-2.5 rounded-lg border px-2.5 py-1.5">
                {g.subjectType === "space" ? (
                  <span className="grid size-7 place-items-center rounded-full bg-primary/10 text-primary">
                    <Icon name="users" size={14} />
                  </span>
                ) : (
                  <PersonAvatar name={label(g)} size="md" />
                )}
                <span className="min-w-0 flex-1 truncate text-[13.5px]">{label(g)}</span>
                <span className="text-[12px] capitalize text-muted-foreground">{g.relation}</span>
                <button
                  className="text-muted-foreground hover:text-destructive disabled:opacity-40"
                  disabled={busy}
                  onClick={() => void run(() => unshareFile(fileId, g))}
                  aria-label="Remove access"
                >
                  <Icon name="x" size={15} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RoleSelect({ value, onChange }: { value: Role; onChange: (r: Role) => void }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Role)}>
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
  );
}
