import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Icon } from "@/lib/icons";
import { PersonAvatar } from "@/components/person-avatar";
import { PeoplePicker } from "@/components/people-picker";
import {
  createShare,
  listFolderGrants,
  listGrants,
  listShares,
  listSpaces,
  revokeShare,
  shareFile,
  shareFolder,
  unshareFile,
  unshareFolder,
  type Grant,
  type Role,
  type ShareLink,
  type ShareTarget,
  type SpaceView,
} from "@/lib/api";

const ROLES: Role[] = ["viewer", "editor", "owner"];

/** People/places sharing backend for a target — null for spaces (membership lives in its own dialog). */
function peopleApi(target: ShareTarget) {
  if (target.kind === "file")
    return {
      list: () => listGrants(target.fileId),
      add: (s: { subjectType: "user" | "space" | "email"; subjectId: string }, role: Role) => shareFile(target.fileId, s, role),
      remove: (g: Grant) => unshareFile(target.fileId, g),
    };
  if (target.kind === "folder")
    return {
      list: () => listFolderGrants(target.spaceId, target.path),
      add: (s: { subjectType: "user" | "space" | "email"; subjectId: string }, role: Role) =>
        shareFolder(target.spaceId, target.path, s, role),
      remove: (g: Grant) => unshareFolder(target.spaceId, target.path, g),
    };
  return null;
}

/**
 * Unified Share dialog for a file, folder, or space. Two always-visible
 * sections — "People with access" (identity grants, for files/folders) and
 * "Anyone with the link" (capability links, web + WebDAV) — each listing current
 * shares with revoke. Space membership lives in its own dialog, so a space here
 * shows links only.
 */
export function ShareDialog({
  target,
  label: title,
  open,
  onOpenChange,
}: {
  target: ShareTarget;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const api = peopleApi(target);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [spaces, setSpaces] = useState<SpaceView[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const spaceName = (id: string) => spaces.find((s) => s.id === id)?.name ?? "Space";
  const key = JSON.stringify(target);

  async function refresh() {
    if (!api) return;
    try {
      setGrants(await api.list());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const [g, s] = await Promise.all([api ? api.list() : Promise.resolve([]), listSpaces()]);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key]);

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
    if (g.subjectType === "space") return spaceName(g.subjectId);
    // A resolved user grant carries a name/email; fall back to the raw id.
    return g.name ?? g.email ?? g.subjectId;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="truncate">Share “{title}”</DialogTitle>
        </DialogHeader>

        {api && (
          <>
            {/* add a person — search connected people, or type any email to invite */}
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!email.trim()) return;
                void run(async () => {
                  await api.add({ subjectType: "email", subjectId: email.trim() }, role);
                  setEmail("");
                });
              }}
            >
              <PeoplePicker
                value={email}
                onChange={setEmail}
                placeholder="Add people by name or email…"
                disabled={busy}
                exclude={(p) =>
                  grants.some(
                    (g) =>
                      (g.subjectType === "user" && g.subjectId === p.sub) ||
                      (g.subjectType === "email" && g.email === p.email),
                  )
                }
                onPick={(p) =>
                  void run(async () => {
                    await api.add({ subjectType: "user", subjectId: p.sub }, role);
                    setEmail("");
                  })
                }
              />
              <RoleSelect value={role} onChange={setRole} />
              <Button type="submit" size="sm" disabled={busy || !email.trim()}>
                Share
              </Button>
            </form>

            {/* share with a whole space (place) */}
            {spaces.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {spaces.map((s) => (
                  <Button
                    key={s.id}
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    className="gap-1.5"
                    onClick={() => void run(() => api.add({ subjectType: "space", subjectId: s.id }, role))}
                  >
                    <Icon name="users" size={13} /> {s.name}
                  </Button>
                ))}
              </div>
            )}

            {error && <p className="text-[12.5px] text-destructive">{error}</p>}

            {/* who has access */}
            <div className="mt-1">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">People with access</div>
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
                      onClick={() => void run(() => api.remove(g))}
                      aria-label="Remove access"
                    >
                      <Icon name="x" size={15} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* anyone with the link (web + WebDAV) */}
        <LinkShares target={target} />
      </DialogContent>
    </Dialog>
  );
}

const LINK_ROLES: ("viewer" | "editor")[] = ["viewer", "editor"];

/**
 * "Anyone with the link" — capability share links (see store/shares.ts). Each
 * link is an unguessable secret, shown once: usable as a web link (`/s/<secret>`)
 * and as a WebDAV mount (the secret is the Basic password, the link id the
 * username). Distinct from the per-person grants above.
 */
export function LinkShares({ target }: { target: ShareTarget }) {
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [fresh, setFresh] = useState<{ id: string; secret: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const key = JSON.stringify(target);
  useEffect(() => {
    setFresh(null);
    listShares(target).then(setLinks).catch(() => setLinks([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  async function copy(text: string, tag: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied((c) => (c === tag ? null : c)), 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  async function create() {
    setBusy(true);
    try {
      const out = await createShare(target, { role });
      setFresh(out);
      setLinks(await listShares(target).catch(() => links));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    try {
      await revokeShare(id);
      if (fresh?.id === id) setFresh(null);
      setLinks(await listShares(target).catch(() => links));
    } finally {
      setBusy(false);
    }
  }

  const origin = window.location.origin;
  const webLink = fresh ? `${origin}/s/${fresh.secret}` : "";
  const davUrl = `${origin}/dav`;

  return (
    <div className="mt-1 border-t pt-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Anyone with the link</span>
        <div className="flex items-center gap-2">
          <Select value={role} onValueChange={(v) => setRole(v as "viewer" | "editor")}>
            <SelectTrigger className="w-[104px]" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LINK_ROLES.map((r) => (
                <SelectItem key={r} value={r} className="capitalize">
                  {r === "editor" ? "Can edit" : "Can view"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" disabled={busy} onClick={() => void create()}>
            Create link
          </Button>
        </div>
      </div>

      {/* freshly created secret — shown once */}
      {fresh && (
        <div className="mb-2 rounded-lg border border-primary/40 bg-primary/[0.06] p-3 text-[12.5px]">
          <div className="mb-1.5 font-medium">Copy now — the secret won't be shown again.</div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Web link</div>
          <div className="mt-1 mb-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 font-mono text-[12px]">{webLink}</code>
            <Button variant="ghost" size="sm" onClick={() => void copy(webLink, "web")}>
              {copied === "web" ? "Copied" : "Copy"}
            </Button>
          </div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">WebDAV mount</div>
          <div className="mt-1 text-muted-foreground">
            In Finder: <span className="font-medium text-foreground">Go → Connect to Server…</span>, paste the URL, then sign in
            with the username + password below.
          </div>
          <div className="mt-1.5 grid grid-cols-[80px_1fr_auto] items-center gap-x-2 gap-y-1">
            <span className="text-[11px] text-muted-foreground">URL</span>
            <code className="min-w-0 truncate rounded bg-background px-2 py-1 font-mono text-[12px]">{davUrl}</code>
            <Button variant="ghost" size="sm" onClick={() => void copy(davUrl, "url")}>
              {copied === "url" ? "Copied" : "Copy"}
            </Button>
            <span className="text-[11px] text-muted-foreground">Username</span>
            <code className="min-w-0 truncate rounded bg-background px-2 py-1 font-mono text-[12px]">{fresh.id}</code>
            <Button variant="ghost" size="sm" onClick={() => void copy(fresh.id, "user")}>
              {copied === "user" ? "Copied" : "Copy"}
            </Button>
            <span className="text-[11px] text-muted-foreground">Password</span>
            <code className="min-w-0 truncate rounded bg-background px-2 py-1 font-mono text-[12px]">{fresh.secret}</code>
            <Button variant="ghost" size="sm" onClick={() => void copy(fresh.secret, "pass")}>
              {copied === "pass" ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {links.length === 0 && !fresh && <p className="text-[13px] text-muted-foreground">No links yet.</p>}
        {links.map((l) => (
          <div key={l.id} className="flex items-center gap-2.5 rounded-lg border px-2.5 py-1.5">
            <span className="grid size-7 place-items-center rounded-full bg-primary/10 text-primary">
              <Icon name="cloud" size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px]">{l.role === "editor" ? "Anyone with the link can edit" : "Anyone with the link can view"}</div>
              <div className="truncate text-[11px] text-muted-foreground">
                {l.lastUsedAt ? `Last used ${new Date(l.lastUsedAt).toLocaleDateString()}` : "Never used"}
              </div>
            </div>
            <button
              className="text-muted-foreground hover:text-destructive disabled:opacity-40"
              disabled={busy}
              onClick={() => void revoke(l.id)}
              aria-label="Revoke link"
            >
              <Icon name="x" size={15} />
            </button>
          </div>
        ))}
      </div>
    </div>
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
