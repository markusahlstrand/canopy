import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/lib/icons";
import { PersonAvatar } from "@/components/person-avatar";
import { PeoplePicker } from "@/components/people-picker";
import { PLUGIN_CATALOG } from "@/lib/mock-data";
import {
  addMember,
  applySpacePlugin,
  createInvite,
  deleteSpace,
  getSpacePlugins,
  inviteUrl,
  listInvites,
  listMembers,
  removeMember,
  removeSpacePlugin,
  renameSpace,
  revokeInvite,
  type Member,
  type Role,
  type SpaceInvite,
} from "@/lib/api";

const ROLES: Role[] = ["viewer", "editor", "owner"];

/**
 * Manage a space (a family/group): who belongs to it, and which plugins it runs.
 * A plugin applied here is active for *every* member; only an owner (the place's
 * "admin") can add or remove members and plugins — others see a read-only view.
 */
export function SpaceMembersDialog({
  spaceId,
  spaceName,
  role,
  open,
  onOpenChange,
  onPluginsChanged,
  initialTab = "members",
  onRenamed,
  onDeleted,
}: {
  spaceId: string;
  spaceName: string;
  /** The caller's role on this space; only an owner may make changes. */
  role: Role;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a plugin is applied/removed, so the host can refresh its active set. */
  onPluginsChanged?: () => void;
  /** Which tab to open on (e.g. "settings" when launched from the sidebar's settings entry). */
  initialTab?: "members" | "plugins" | "settings";
  /** Called after the space is renamed, so the host can refresh its name in the switcher. */
  onRenamed?: (name: string) => void;
  /** Called after the space is deleted, so the host can close + navigate away. */
  onDeleted?: () => void;
}) {
  const canManage = role === "owner";
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<SpaceInvite[]>([]);
  const [appliedPlugins, setAppliedPlugins] = useState<string[]>([]);
  const [email, setEmail] = useState("");
  const [memberRole, setMemberRole] = useState<Role>("editor");
  const [linkRole, setLinkRole] = useState<Role>("editor");
  const [name, setName] = useState(spaceName);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pluginBusy, setPluginBusy] = useState<string | null>(null);
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
    const [m, inv, plugins] = await Promise.all([listMembers(spaceId), listInvites(spaceId), getSpacePlugins(spaceId)]);
    setMembers(m);
    setInvites(inv);
    setAppliedPlugins(plugins);
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const [m, inv, plugins] = await Promise.all([
          listMembers(spaceId),
          listInvites(spaceId),
          getSpacePlugins(spaceId),
        ]);
        if (!cancelled) {
          setMembers(m);
          setInvites(inv);
          setAppliedPlugins(plugins);
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

  async function togglePlugin(pluginId: string, applied: boolean) {
    setPluginBusy(pluginId);
    setError(null);
    try {
      if (applied) await removeSpacePlugin(spaceId, pluginId);
      else await applySpacePlugin(spaceId, pluginId);
      setAppliedPlugins((prev) => (applied ? prev.filter((id) => id !== pluginId) : [...prev, pluginId]));
      onPluginsChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPluginBusy(null);
    }
  }

  // Delete is terminal — don't refresh() afterwards (the space is gone); hand off to
  // the host to close the dialog and navigate away.
  async function doDelete() {
    setBusy(true);
    setError(null);
    try {
      await deleteSpace(spaceId);
      onDeleted?.();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="truncate">{spaceName}</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue={initialTab} className="flex min-h-0 flex-1 flex-col gap-3">
          <TabsList className="shrink-0 self-start">
            <TabsTrigger value="members">Members</TabsTrigger>
            <TabsTrigger value="plugins">Plugins</TabsTrigger>
            {canManage && <TabsTrigger value="settings">Settings</TabsTrigger>}
          </TabsList>

          <TabsContent value="members" className="flex min-h-0 flex-1 flex-col gap-3">
            {canManage && (
              <form
                className="flex shrink-0 items-center gap-2"
                autoComplete="off"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!email.trim()) return;
                  void run(async () => {
                    await addMember(spaceId, email.trim(), memberRole);
                    setEmail("");
                  });
                }}
              >
                <PeoplePicker
                  value={email}
                  onChange={setEmail}
                  placeholder="Add by name or email…"
                  disabled={busy}
                  exclude={(p) =>
                    members.some((m) => (m.sub && m.sub === p.sub) || (!!m.email && m.email === p.email))
                  }
                  onPick={(p) => {
                    // Membership is keyed by email (resolved to a user on the server);
                    // a connected contact always has one, but guard just in case.
                    if (!p.email) return;
                    void run(async () => {
                      await addMember(spaceId, p.email!, memberRole);
                      setEmail("");
                    });
                  }}
                />
                <Select value={memberRole} onValueChange={(v) => setMemberRole(v as Role)}>
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
            )}

            {/* Invite links: one-time tokens. Whoever opens one signs in (with any
                account) and joins at the link's role — no email needed up front. */}
            {canManage && (
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
            )}

            {error && <p className="shrink-0 text-[12.5px] text-destructive">{error}</p>}

            <div className="-mx-1 flex flex-1 flex-col gap-1.5 overflow-y-auto px-1">
              {members.map((m) => (
                <div key={m.sub || m.email} className="flex items-center gap-2.5 rounded-lg border px-2.5 py-1.5">
                  <PersonAvatar name={m.name ?? m.email ?? m.sub} size="md" />
                  <span className="min-w-0 flex-1 truncate text-[13.5px]">
                    {m.email ?? m.name ?? m.sub}
                    {m.pending && <span className="ml-1.5 text-[11px] text-muted-foreground">· invited</span>}
                  </span>
                  <span className="text-[12px] capitalize text-muted-foreground">{m.role}</span>
                  {canManage && m.role !== "owner" && (
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
              {canManage
                ? "Add someone by email, or send a one-time invite link. Either way they get access the moment they sign in — with whichever account they choose."
                : "Only an owner of this space can add or remove members."}
            </p>
          </TabsContent>

          <TabsContent value="plugins" className="flex min-h-0 flex-1 flex-col gap-2">
            <p className="shrink-0 text-[12px] text-muted-foreground">
              {canManage
                ? "Plugins applied here are turned on for everyone in this space."
                : "Plugins an owner has applied here are turned on for everyone in this space."}
            </p>
            {error && <p className="shrink-0 text-[12.5px] text-destructive">{error}</p>}
            <div className="-mx-1 flex flex-1 flex-col gap-1.5 overflow-y-auto px-1">
              {PLUGIN_CATALOG.map((p) => {
                const applied = appliedPlugins.includes(p.id);
                if (!canManage && !applied) return null;
                return (
                  <label
                    key={p.id}
                    className="flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-[13.5px]"
                  >
                    {canManage ? (
                      <Checkbox
                        checked={applied}
                        disabled={pluginBusy === p.id}
                        onCheckedChange={() => void togglePlugin(p.id, applied)}
                      />
                    ) : (
                      <Icon name="circle-check" size={16} className="text-primary" />
                    )}
                    <div
                      className="grid size-7 shrink-0 place-items-center rounded-md"
                      style={{ background: `hsl(${p.color} / 0.14)`, color: `hsl(${p.color})` }}
                    >
                      <Icon name={p.icon} size={15} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{p.label}</div>
                      <div className="truncate text-[11.5px] text-muted-foreground">{p.tagline}</div>
                    </div>
                    {pluginBusy === p.id && <span className="text-[11px] text-muted-foreground">…</span>}
                  </label>
                );
              })}
              {!canManage && appliedPlugins.length === 0 && (
                <p className="px-1 text-[12.5px] text-muted-foreground">No plugins applied to this space yet.</p>
              )}
            </div>
          </TabsContent>

          {canManage && (
            <TabsContent value="settings" className="flex min-h-0 flex-1 flex-col gap-4">
              {error && <p className="shrink-0 text-[12.5px] text-destructive">{error}</p>}

              <form
                className="flex shrink-0 flex-col gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  const next = name.trim();
                  if (!next || next === spaceName) return;
                  void run(async () => {
                    await renameSpace(spaceId, next);
                    onRenamed?.(next);
                  });
                }}
              >
                <label className="text-[12px] font-medium text-muted-foreground">Space name</label>
                <div className="flex items-center gap-2">
                  <Input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
                  <Button type="submit" size="sm" disabled={busy || !name.trim() || name.trim() === spaceName}>
                    Save
                  </Button>
                </div>
              </form>

              {/* Danger zone — deleting is permanent and affects every member. */}
              <div className="mt-auto flex shrink-0 flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                <span className="text-[12.5px] font-medium text-destructive">Delete this space</span>
                <p className="text-[12px] text-muted-foreground">
                  Permanently removes the space and all of its files for everyone in it. This can’t be undone.
                </p>
                {confirmingDelete ? (
                  <div className="flex items-center gap-2">
                    <Button variant="destructive" size="sm" disabled={busy} onClick={() => void doDelete()}>
                      Yes, delete “{spaceName}”
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmingDelete(false)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="self-start gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setConfirmingDelete(true)}
                  >
                    <Icon name="trash" size={14} /> Delete space
                  </Button>
                )}
              </div>
            </TabsContent>
          )}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
