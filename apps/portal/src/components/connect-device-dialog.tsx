import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/lib/icons";
import { createAppPassword, deleteAppPassword, listAppPasswords, type AppPassword } from "@/lib/api";

/**
 * Connect a device over WebDAV: create/revoke app passwords and show the mount
 * URL + how to connect from Finder. The token is shown once on creation.
 */
export function ConnectDeviceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [passwords, setPasswords] = useState<AppPassword[]>([]);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<{ token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const davUrl = `${window.location.origin}/dav`;

  useEffect(() => {
    if (!open) return;
    setFresh(null);
    listAppPasswords().then(setPasswords).catch(() => setPasswords([]));
  }, [open]);

  async function refresh() {
    setPasswords(await listAppPasswords().catch(() => []));
  }

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const { token } = await createAppPassword(name.trim());
      setFresh({ token });
      setName("");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Connect a device (WebDAV)</DialogTitle>
        </DialogHeader>

        <div className="rounded-lg bg-muted/60 p-3 text-[12.5px] leading-relaxed text-muted-foreground">
          In Finder: <span className="font-medium text-foreground">Go → Connect to Server…</span>, enter the URL
          below, then sign in with <span className="font-medium text-foreground">any username</span> and an app
          password as the password.
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 font-mono text-[12px] text-foreground">
              {davUrl}
            </code>
            <Button variant="ghost" size="sm" onClick={() => void copy(davUrl)}>
              Copy
            </Button>
          </div>
        </div>

        {/* freshly created token (shown once) */}
        {fresh && (
          <div className="rounded-lg border border-primary/40 bg-primary/[0.06] p-3">
            <div className="mb-1 text-[12px] font-medium">Your new app password (copy it now — it won't be shown again):</div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 font-mono text-[12.5px]">{fresh.token}</code>
              <Button size="sm" onClick={() => void copy(fresh.token)}>
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        )}

        {/* create */}
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <Input placeholder="Device name (e.g. Markus's Mac)" value={name} onChange={(e) => setName(e.target.value)} className="flex-1" />
          <Button type="submit" size="sm" disabled={busy || !name.trim()}>
            Create
          </Button>
        </form>

        {/* existing */}
        <div className="flex flex-col gap-1.5">
          {passwords.length === 0 && <p className="text-[13px] text-muted-foreground">No app passwords yet.</p>}
          {passwords.map((p) => (
            <div key={p.id} className="flex items-center gap-2.5 rounded-lg border px-2.5 py-1.5">
              <Icon name="cloud" size={15} className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[13.5px]">{p.name}</span>
              <span className="text-[11.5px] text-muted-foreground">
                {p.lastUsedAt ? "used" : "never used"}
              </span>
              <button
                className="text-muted-foreground hover:text-destructive disabled:opacity-40"
                disabled={busy}
                onClick={() => void deleteAppPassword(p.id).then(refresh)}
                aria-label="Revoke"
              >
                <Icon name="x" size={15} />
              </button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
