import { useCallback, useEffect, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { createBranch, deleteBranch, listBranches, switchBranch, type BranchInfo } from "@/lib/api";

/**
 * Git-style branch picker for a connected (GitHub) space, shown in the topbar while
 * that space is open. Lists the repo's branches and lets the user switch (persisted +
 * re-indexed server-side), create a branch off the current one, and delete a branch.
 *
 * Self-contained: it probes `listBranches`, and renders nothing when the connector
 * has no branch concept (a NAS) or the repo isn't reachable — so the topbar simply
 * shows no picker. A successful switch calls `onSwitched` so the host reloads the view.
 */
export function BranchPicker({ pluginId, onSwitched }: { pluginId: string; onSwitched: () => void }) {
  const [open, setOpen] = useState(false);
  const [supported, setSupported] = useState(false);
  const [canSwitch, setCanSwitch] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // a branch name being switched/deleted
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await listBranches(pluginId);
    setSupported(res.supported);
    setCanSwitch(res.canSwitch);
    setCurrent(res.current);
    setBranches(res.branches);
    setLoading(false);
  }, [pluginId]);

  // Probe once on mount (and whenever the space changes) so the trigger can show the
  // current branch and the picker hides itself for non-branch connectors.
  useEffect(() => {
    setSupported(false);
    setBranches([]);
    void load();
  }, [load]);

  // Refresh the list each time the popover opens (someone may have pushed a branch).
  useEffect(() => {
    if (open) void load();
    else {
      setCreating(false);
      setNewName("");
      setError(null);
    }
  }, [open, load]);

  if (!supported) return null;

  async function onSwitch(name: string) {
    if (name === current) {
      setOpen(false);
      return;
    }
    setBusy(name);
    setError(null);
    try {
      await switchBranch(pluginId, name);
      setCurrent(name);
      setOpen(false);
      onSwitched();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onDelete(name: string) {
    setBusy(name);
    setError(null);
    try {
      await deleteBranch(pluginId, name);
      setBranches((prev) => prev.filter((b) => b.name !== name));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onCreate() {
    const name = newName.trim();
    if (!name) return;
    setBusy("__create__");
    setError(null);
    try {
      await createBranch(pluginId, name, current ?? undefined);
      setNewName("");
      setCreating(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="flex h-8 max-w-[220px] items-center gap-1.5 rounded-md border px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          title="Switch branch"
        >
          <Icon name="github" size={14} className="shrink-0" />
          <span className="truncate font-medium text-foreground">{current ?? "branch"}</span>
          <Icon name="chevron-down" size={13} className="shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-[12.5px] font-medium">Switch branches</span>
          <button
            onClick={() => setCreating((v) => !v)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Icon name="plus" size={13} /> New
          </button>
        </div>

        {creating && (
          <div className="flex items-center gap-1.5 border-b bg-muted/40 px-3 py-2">
            <Input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void onCreate();
                if (e.key === "Escape") setCreating(false);
              }}
              placeholder={current ? `New branch from ${current}` : "New branch name"}
              className="h-7 text-[12.5px]"
            />
            <Button size="sm" className="h-7 shrink-0 px-2.5 text-[12px]" disabled={!newName.trim() || busy === "__create__"} onClick={() => void onCreate()}>
              {busy === "__create__" ? "…" : "Create"}
            </Button>
          </div>
        )}

        <div className="max-h-[280px] overflow-y-auto py-1">
          {loading && branches.length === 0 ? (
            <p className="px-3 py-2 text-[12.5px] text-muted-foreground">Loading branches…</p>
          ) : branches.length === 0 ? (
            <p className="px-3 py-2 text-[12.5px] text-muted-foreground">No branches.</p>
          ) : (
            branches.map((b) => {
              const isCurrent = b.name === current;
              const rowBusy = busy === b.name;
              return (
                <div
                  key={b.name}
                  className={cn(
                    "group flex items-center gap-2 px-3 py-1.5 text-[13px]",
                    canSwitch && !isCurrent && "cursor-pointer hover:bg-accent/60",
                  )}
                  onClick={() => canSwitch && !rowBusy && void onSwitch(b.name)}
                >
                  <span className="flex w-4 shrink-0 justify-center">
                    {isCurrent ? (
                      <Icon name="circle-check" size={14} className="text-primary" />
                    ) : rowBusy ? (
                      <Icon name="refresh" size={13} className="animate-spin text-muted-foreground" />
                    ) : null}
                  </span>
                  <span className={cn("min-w-0 flex-1 truncate", isCurrent && "font-medium")}>{b.name}</span>
                  {b.isDefault && (
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">default</span>
                  )}
                  {!b.isDefault && !isCurrent && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!rowBusy) void onDelete(b.name);
                      }}
                      title={`Delete ${b.name}`}
                      aria-label={`Delete ${b.name}`}
                      className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>

        {!canSwitch && supported && (
          <p className="border-t px-3 py-2 text-[11.5px] text-muted-foreground">
            Connect your own repository in the plugin settings to switch the active branch.
          </p>
        )}
        {error && <p className="border-t px-3 py-2 text-[11.5px] text-destructive">{error}</p>}
      </PopoverContent>
    </Popover>
  );
}
