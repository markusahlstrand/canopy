import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/lib/icons";
import { createAppPassword, deleteAppPassword, listAppPasswords, type AppPassword } from "@/lib/api";

/** Format an ISO timestamp as a short local date, or a fallback. */
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : null);

/**
 * Connect a device over WebDAV: create/revoke app passwords (the connected
 * clients), and show the mount URL + how to connect from Finder. The token is
 * shown once on creation. `currentUrl`/`currentLabel`, when given, offer to mount
 * just the place/folder the user is currently viewing (the same password works
 * for any path — the URL is what scopes the mount).
 */
export function ConnectDeviceDialog({
  open,
  onOpenChange,
  currentUrl,
  currentLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentUrl?: string;
  currentLabel?: string;
}) {
  const [passwords, setPasswords] = useState<AppPassword[]>([]);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<{ token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const davUrl = `${window.location.origin}/dav`;
  // Only offer the current location when it's a deeper mount than the whole drive.
  const hereUrl = currentUrl && currentUrl !== davUrl ? currentUrl : null;

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
          In Finder: <span className="font-medium text-foreground">Go → Connect to Server…</span>, paste a URL
          below, then sign in with <span className="font-medium text-foreground">any username</span> and an app
          password as the password. Once mounted it works like any folder — browse, open, and drag files in or out.

          <div className="mt-2.5 text-[11px] font-medium uppercase tracking-wide">Whole drive</div>
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 font-mono text-[12px] text-foreground">
              {davUrl}
            </code>
            <Button variant="ghost" size="sm" onClick={() => void copy(davUrl)}>
              Copy
            </Button>
          </div>

          {hereUrl && (
            <>
              <div className="mt-2.5 text-[11px] font-medium uppercase tracking-wide">
                Just this folder{currentLabel ? ` — ${currentLabel}` : ""}
              </div>
              <div className="mt-1 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 font-mono text-[12px] text-foreground">
                  {hereUrl}
                </code>
                <Button variant="ghost" size="sm" onClick={() => void copy(hereUrl)}>
                  Copy
                </Button>
              </div>
            </>
          )}
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

        {/* connected clients (one app password per device) */}
        <div className="flex flex-col gap-1.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Connected devices</div>
          {passwords.length === 0 && <p className="text-[13px] text-muted-foreground">No devices connected yet.</p>}
          {passwords.map((p) => {
            const last = fmtDate(p.lastUsedAt);
            const added = fmtDate(p.createdAt);
            return (
              <div key={p.id} className="flex items-center gap-2.5 rounded-lg border px-2.5 py-1.5">
                <Icon name="cloud" size={15} className="text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px]">{p.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {last ? `Last used ${last}` : "Never used"}
                    {added ? ` · added ${added}` : ""}
                  </div>
                </div>
                <button
                  className="text-muted-foreground hover:text-destructive disabled:opacity-40"
                  disabled={busy}
                  onClick={() => void deleteAppPassword(p.id).then(refresh)}
                  aria-label="Revoke"
                >
                  <Icon name="x" size={15} />
                </button>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
