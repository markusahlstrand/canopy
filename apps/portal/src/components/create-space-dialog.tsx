import { useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { PersonAvatar } from "@/components/person-avatar";
import { PeoplePicker } from "@/components/people-picker";
import { PLUGIN_CATALOG, STORAGE } from "@/lib/mock-data";
import {
  addMember,
  applySpacePlugin,
  createInvite,
  createSpace,
  inviteUrl,
  setSpaceMounted,
  type Person,
  type Role,
} from "@/lib/api";

/** Icons offered for a space. Every name must exist in the icon map (lib/icons). */
const SPACE_ICONS = [
  "users",
  "home",
  "star",
  "image",
  "calendar",
  "folder",
  "bookmark",
  "utensils",
  "globe",
  "package",
  "flame",
  "gamepad",
];

/** Accent colors as HSL triplets (the same convention plugin colors use). */
const SPACE_COLORS = [
  "145 33% 36%", // canopy green
  "212 70% 48%", // blue
  "262 60% 55%", // purple
  "190 65% 42%", // teal
  "32 85% 52%", // amber
  "350 72% 56%", // rose
  "20 70% 50%", // terracotta
  "240 6% 42%", // slate
];

/**
 * Where a space's files live. Only managed Canopy storage is wired today; the
 * others are shown so the choice reads as "this is selectable" and to leave an
 * obvious hook for per-space backends (the `connections` table) later.
 */
const STORAGE_OPTIONS = [
  { id: "canopy", label: "Canopy storage", sub: `${STORAGE.label} · ${STORAGE.used} of ${STORAGE.total} used`, icon: "cloud", available: true },
  { id: "synology", label: "Synology NAS", sub: "Keep files on your own NAS", icon: "hard-drive", available: false },
  { id: "s3", label: "Amazon S3", sub: "Bring your own bucket", icon: "database", available: false },
];

/** Feature plugins worth turning on for a whole space up front (full set lives in space settings). */
const SUGGESTED_PLUGIN_IDS = ["calendar", "tasks", "document-ai"];

const ROLES: Role[] = ["viewer", "editor", "owner"];

interface PendingMember {
  email: string;
  name: string | null;
  role: Role;
}

/**
 * Create a shared (group) space with a proper UI instead of a native prompt:
 * name + icon/color, a storage backend, who has access, which apps run in it,
 * whether it shows in My Drive, and an optional one-time invite link.
 *
 * Everything past the name is layered on with the existing per-space APIs after
 * the space is created (addMember / applySpacePlugin / setSpaceMounted /
 * createInvite), so a failure there leaves a usable space rather than aborting.
 */
export function CreateSpaceDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The space was created (and configured); the host refreshes its list + opens it. */
  onCreated: (space: { id: string; name: string }) => void;
}) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState(SPACE_ICONS[0]!);
  const [color, setColor] = useState(SPACE_COLORS[0]!);
  const [storage, setStorage] = useState("canopy");
  const [members, setMembers] = useState<PendingMember[]>([]);
  const [email, setEmail] = useState("");
  const [memberRole, setMemberRole] = useState<Role>("editor");
  const [plugins, setPlugins] = useState<string[]>([]);
  const [showInDrive, setShowInDrive] = useState(true);
  const [withInvite, setWithInvite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // After a successful create that minted an invite link: the link to copy.
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [iconOpen, setIconOpen] = useState(false);

  const suggestedPlugins = SUGGESTED_PLUGIN_IDS.map((id) => PLUGIN_CATALOG.find((p) => p.id === id)).filter(
    (p): p is NonNullable<typeof p> => !!p,
  );

  function addPending(emailRaw: string, personName: string | null) {
    const e = emailRaw.trim().toLowerCase();
    if (!e || members.some((m) => m.email === e)) return;
    setMembers((prev) => [...prev, { email: e, name: personName, role: memberRole }]);
    setEmail("");
  }

  function onPickPerson(p: Person) {
    if (!p.email) return; // membership is keyed by email
    addPending(p.email, p.name);
  }

  async function copyLink() {
    if (!createdLink) return;
    try {
      await navigator.clipboard.writeText(createdLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the link is on screen to copy by hand */
    }
  }

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const space = await createSpace(trimmed, { icon, color });

      // Layer the rest on with the per-space APIs. Tolerate partial failure (a bad
      // email, an unknown plugin) — the space already exists, so we note it rather
      // than throwing the whole thing away.
      const results = await Promise.allSettled([
        ...members.map((m) => addMember(space.id, m.email, m.role)),
        ...plugins.map((id) => applySpacePlugin(space.id, id)),
        ...(showInDrive ? [] : [setSpaceMounted(space.id, false)]),
      ]);
      const failed = results.filter((r) => r.status === "rejected").length;

      let link: string | null = null;
      if (withInvite) {
        const invite = await createInvite(space.id, "editor");
        link = inviteUrl(invite.token);
      }

      // Hand off to the host (refresh + open the space) before we either close or
      // reveal the invite link.
      onCreated({ id: space.id, name: space.name });

      // A toast (not inline error) so the note survives the dialog closing.
      if (failed > 0) {
        toast("Space created", { description: `${failed} of your additions couldn't be applied.` });
      }

      if (link) {
        setCreatedLink(link);
        setBusy(false);
      } else {
        onOpenChange(false);
      }
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  // ── Success step: a space was created and an invite link is ready to copy ──
  if (createdLink) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>“{name.trim()}” is ready</DialogTitle>
            <DialogDescription>
              Share this one-time link to invite someone as an editor. It works once, then expires.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-lg bg-muted/60 p-2.5">
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground">{createdLink}</span>
            <Button size="sm" onClick={() => void copyLink()}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[480px]">
        <DialogHeader className="px-5 pt-5">
          <DialogTitle>Create a space</DialogTitle>
          <DialogDescription>
            A shared place for a family, team, or project. You’ll be its owner.
          </DialogDescription>
        </DialogHeader>

        <form
          id="create-space"
          className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            void handleCreate();
          }}
        >
          {/* Name + icon/color */}
          <div className="flex items-center gap-2.5">
            <Popover open={iconOpen} onOpenChange={setIconOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="Pick an icon and color"
                  className="grid size-10 shrink-0 place-items-center rounded-lg ring-1 ring-inset ring-border transition hover:ring-2"
                  style={{ background: `hsl(${color} / 0.16)`, color: `hsl(${color})` }}
                >
                  <Icon name={icon} size={20} />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-64 p-3">
                <div className="mb-2 grid grid-cols-6 gap-1.5">
                  {SPACE_ICONS.map((ic) => (
                    <button
                      key={ic}
                      type="button"
                      onClick={() => setIcon(ic)}
                      className={cn(
                        "grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent",
                        ic === icon && "bg-accent text-foreground ring-1 ring-border",
                      )}
                    >
                      <Icon name={ic} size={17} />
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {SPACE_COLORS.map((cl) => (
                    <button
                      key={cl}
                      type="button"
                      onClick={() => setColor(cl)}
                      aria-label={`Color ${cl}`}
                      className={cn(
                        "size-6 rounded-full ring-offset-2 ring-offset-popover transition",
                        cl === color && "ring-2 ring-foreground",
                      )}
                      style={{ background: `hsl(${cl})` }}
                    />
                  ))}
                </div>
              </PopoverContent>
            </Popover>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Space name (e.g. Family)"
              disabled={busy}
            />
          </div>

          {/* Storage */}
          <section className="flex flex-col gap-1.5">
            <label className="text-[12px] font-medium text-muted-foreground">Storage</label>
            <div className="flex flex-col gap-1.5">
              {STORAGE_OPTIONS.map((s) => {
                const selected = storage === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    disabled={!s.available || busy}
                    onClick={() => s.available && setStorage(s.id)}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition",
                      selected ? "border-primary bg-primary/5" : "hover:bg-accent/50",
                      !s.available && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <Icon name={s.icon} size={17} className="shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-[13.5px] font-medium">
                        {s.label}
                        {!s.available && <Badge variant="secondary">Soon</Badge>}
                      </div>
                      <div className="truncate text-[11.5px] text-muted-foreground">{s.sub}</div>
                    </div>
                    <span
                      className={cn(
                        "grid size-4 shrink-0 place-items-center rounded-full border",
                        selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
                      )}
                    >
                      {selected && <Icon name="circle-check" size={14} />}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Members */}
          <section className="flex flex-col gap-1.5">
            <label className="text-[12px] font-medium text-muted-foreground">Who has access</label>
            {/* Enter in this row adds the typed email rather than submitting the whole
                form. When the picker's suggestion dropdown handles Enter (to choose a
                person) it preventDefaults first, so we skip via `defaultPrevented`. */}
            <div
              className="flex items-center gap-2"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.defaultPrevented && email.trim()) {
                  e.preventDefault();
                  addPending(email, null);
                }
              }}
            >
              <PeoplePicker
                value={email}
                onChange={setEmail}
                placeholder="Add by name or email…"
                disabled={busy}
                exclude={(p) => !!p.email && members.some((m) => m.email === p.email!.toLowerCase())}
                onPick={onPickPerson}
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
              <Button type="button" size="sm" disabled={busy || !email.trim()} onClick={() => addPending(email, null)}>
                Add
              </Button>
            </div>
            {members.length > 0 && (
              <div className="flex flex-col gap-1.5 pt-0.5">
                {members.map((m) => (
                  <div key={m.email} className="flex items-center gap-2.5 rounded-lg border px-2.5 py-1.5">
                    <PersonAvatar name={m.name ?? m.email} size="md" />
                    <span className="min-w-0 flex-1 truncate text-[13.5px]">{m.name ?? m.email}</span>
                    <Select
                      value={m.role}
                      onValueChange={(v) =>
                        setMembers((prev) => prev.map((x) => (x.email === m.email ? { ...x, role: v as Role } : x)))
                      }
                    >
                      <SelectTrigger className="h-7 w-[92px] border-none px-2 text-[12px] capitalize shadow-none" size="sm">
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
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => setMembers((prev) => prev.filter((x) => x.email !== m.email))}
                      aria-label={`Remove ${m.email}`}
                    >
                      <Icon name="x" size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[11.5px] text-muted-foreground">
              People get access the moment they sign in — with whichever account they choose.
            </p>
          </section>

          {/* Apps / plugins */}
          <section className="flex flex-col gap-1.5">
            <label className="text-[12px] font-medium text-muted-foreground">Apps for everyone in the space</label>
            <div className="flex flex-col gap-1.5">
              {suggestedPlugins.map((p) => {
                const on = plugins.includes(p.id);
                return (
                  <label
                    key={p.id}
                    className="flex cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-2 text-[13.5px]"
                  >
                    <Checkbox
                      checked={on}
                      disabled={busy}
                      onCheckedChange={() =>
                        setPlugins((prev) => (on ? prev.filter((id) => id !== p.id) : [...prev, p.id]))
                      }
                    />
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
                  </label>
                );
              })}
            </div>
            <p className="text-[11.5px] text-muted-foreground">More apps can be added later in space settings.</p>
          </section>

          {/* Options */}
          <section className="flex flex-col gap-2.5">
            <label className="flex cursor-pointer items-center gap-2.5 text-[13.5px]">
              <Checkbox checked={showInDrive} disabled={busy} onCheckedChange={(v) => setShowInDrive(!!v)} />
              <span className="flex-1">
                Show in My Drive
                <span className="block text-[11.5px] text-muted-foreground">
                  Pin it to the sidebar and merge its files into My Drive.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-center gap-2.5 text-[13.5px]">
              <Checkbox checked={withInvite} disabled={busy} onCheckedChange={(v) => setWithInvite(!!v)} />
              <span className="flex-1">
                Create a shareable invite link
                <span className="block text-[11.5px] text-muted-foreground">
                  A one-time editor link you can copy once the space is created.
                </span>
              </span>
            </label>
          </section>

          {error && <p className="text-[12.5px] text-destructive">{error}</p>}
        </form>

        <DialogFooter className="border-t px-5 py-3">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="create-space" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create space"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
