import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import {
  connectorLogStreamUrl,
  connectorStatus,
  getConnectorSettings,
  setConnectorSettings,
  syncConnector,
  type ConnectorStatus,
  type VersionPolicy,
} from "@/lib/api";

/** Coarse "x ago" for the last-indexed timestamp — enough to convey freshness, no dependency. */
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const min = Math.round(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

/** Wall-clock HH:MM:SS for a log line's epoch-ms timestamp (omitted when absent). */
const fmtTime = (ts: number): string =>
  ts > 0 ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";

interface LogLine {
  key: number;
  message: string;
  level: "info" | "error";
  ts: number;
}

const POLICY_LABEL: Record<VersionPolicy, string> = {
  smart: "Smart (recommended)",
  all: "Keep every version",
  days: "Keep the last N days",
};

/**
 * Settings for a connected (read-only) space — a Synology NAS or a GitHub repo. Two
 * tabs: **Indexing** (last-run status, a force re-index, and a live progress log streamed
 * from the crawl) and **Versions** (the space's retention policy). Distinct from
 * `SpaceMembersDialog`, which is owner/members/plugins oriented; a connected space has no
 * members and reports a `viewer` role, but the user owns it and may configure it.
 *
 * The log is live-only (never persisted): it starts empty and fills as a run emits lines,
 * so the natural flow is *open → Re-index → watch*. Live streaming needs the edge runtime;
 * on Node the stream is absent and only the status shows.
 */
export function ConnectorSettingsDialog({
  pluginId,
  spaceName,
  open,
  onOpenChange,
}: {
  /** The connector plugin id (the `connector:<plugin>` token minus the prefix/sub). */
  pluginId: string;
  spaceName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [status, setStatus] = useState<ConnectorStatus | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [syncing, setSyncing] = useState(false);

  // Versions tab.
  const [policy, setPolicy] = useState<VersionPolicy>("smart");
  const [days, setDays] = useState(30);
  const [loaded, setLoaded] = useState<{ policy: VersionPolicy; days: number } | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);

  const logRef = useRef<HTMLDivElement>(null);
  const lineKey = useRef(0);

  // Load status + retention policy whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void connectorStatus(pluginId).then((s) => !cancelled && setStatus(s));
    void getConnectorSettings(pluginId)
      .then((s) => {
        if (cancelled) return;
        const d = s.versionDays ?? 30;
        setPolicy(s.versionPolicy);
        setDays(d);
        setLoaded({ policy: s.versionPolicy, days: d });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, pluginId]);

  // Poll status on a short interval while open, so the header tracks a run start→finish
  // even between log lines (and reflects extraction draining after the crawl).
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => void connectorStatus(pluginId).then(setStatus), 3000);
    return () => clearInterval(id);
  }, [open, pluginId]);

  // Subscribe to the live indexing log for as long as the dialog is open. Lines are
  // transient (the server stores nothing); the dialog mounts fresh per connector (App
  // keys it on pluginId), so `lines` already starts empty — no reset needed here.
  useEffect(() => {
    if (!open || typeof EventSource === "undefined") return;
    const es = new EventSource(connectorLogStreamUrl(pluginId));
    es.addEventListener("index", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { message?: string; level?: string; ts?: number };
        if (!d.message) return;
        const line: LogLine = {
          key: lineKey.current++,
          message: d.message,
          level: d.level === "error" ? "error" : "info",
          ts: d.ts ?? 0,
        };
        setLines((prev) => {
          const next = [...prev, line];
          // Cap so a huge crawl can't grow the DOM unbounded; the tail is what matters.
          return next.length > 500 ? next.slice(-500) : next;
        });
      } catch {
        /* malformed line — skip */
      }
    });
    return () => es.close();
  }, [open, pluginId]);

  // Keep the log pinned to the newest line.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  async function reindex() {
    setSyncing(true);
    try {
      await syncConnector(pluginId);
      // Give the run a beat to record its row, then refresh the header.
      setTimeout(() => void connectorStatus(pluginId).then(setStatus), 1200);
    } finally {
      setSyncing(false);
    }
  }

  async function savePolicy() {
    setSavingPolicy(true);
    setPolicyError(null);
    try {
      const saved = await setConnectorSettings(pluginId, policy, policy === "days" ? days : null);
      const d = saved.versionDays ?? 30;
      setPolicy(saved.versionPolicy);
      setDays(d);
      setLoaded({ policy: saved.versionPolicy, days: d });
    } catch (e) {
      setPolicyError((e as Error).message);
    } finally {
      setSavingPolicy(false);
    }
  }

  const indexing = status?.indexing ?? false;
  const policyDirty = !loaded || loaded.policy !== policy || (policy === "days" && loaded.days !== days);
  const daysValid = policy !== "days" || (Number.isFinite(days) && days >= 1);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="truncate">{spaceName}</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="indexing" className="flex min-h-0 flex-1 flex-col gap-3">
          <TabsList className="shrink-0 self-start">
            <TabsTrigger value="indexing">Indexing</TabsTrigger>
            <TabsTrigger value="versions">Versions</TabsTrigger>
          </TabsList>

          {/* ── Indexing ─────────────────────────────────────────────────────── */}
          <TabsContent value="indexing" className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="flex shrink-0 items-center gap-2.5 rounded-lg border px-3 py-2.5">
              <span className={cn("shrink-0", indexing ? "text-primary" : "text-muted-foreground")}>
                <Icon name={indexing ? "refresh" : "database"} size={16} className={indexing ? "animate-spin" : ""} />
              </span>
              <div className="min-w-0 flex-1 text-[13px]">
                {indexing ? (
                  <span>
                    Indexing…
                    {status && status.pending > 0 && (
                      <span className="text-muted-foreground">
                        {" "}
                        {status.pending} file{status.pending === 1 ? "" : "s"} left to extract
                      </span>
                    )}
                  </span>
                ) : status?.lastIndexedAt ? (
                  <span className="text-muted-foreground">Last indexed {timeAgo(status.lastIndexedAt)}</span>
                ) : (
                  <span className="text-muted-foreground">Not indexed yet</span>
                )}
              </div>
              <Button size="sm" variant="outline" className="shrink-0 gap-1.5" disabled={syncing} onClick={() => void reindex()}>
                <Icon name="refresh" size={14} /> Re-index now
              </Button>
            </div>

            <div
              ref={logRef}
              className="min-h-0 flex-1 overflow-y-auto rounded-lg bg-muted/60 p-2.5 font-mono text-[11.5px] leading-relaxed"
            >
              {lines.length === 0 ? (
                <p className="px-0.5 py-1 font-sans text-[12.5px] text-muted-foreground">
                  Re-index to stream progress here. The log is live — it isn’t stored, so it starts fresh each time.
                </p>
              ) : (
                lines.map((l) => (
                  <div key={l.key} className="flex gap-2">
                    <span className="shrink-0 text-muted-foreground/70 tabular-nums">{fmtTime(l.ts)}</span>
                    <span className={cn("min-w-0 break-words", l.level === "error" && "text-destructive")}>{l.message}</span>
                  </div>
                ))
              )}
            </div>
          </TabsContent>

          {/* ── Versions ─────────────────────────────────────────────────────── */}
          <TabsContent value="versions" className="flex min-h-0 flex-1 flex-col gap-4">
            <p className="shrink-0 text-[12.5px] text-muted-foreground">
              How many past versions of each file to keep. The current version and any you’ve pinned are always kept.
            </p>

            <div className="flex shrink-0 flex-col gap-1.5">
              <label className="text-[12px] font-medium text-muted-foreground">Retention</label>
              <Select value={policy} onValueChange={(v) => setPolicy(v as VersionPolicy)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(POLICY_LABEL) as VersionPolicy[]).map((p) => (
                    <SelectItem key={p} value={p}>
                      {POLICY_LABEL[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11.5px] text-muted-foreground">
                {policy === "smart" && "Thins older history automatically: hourly for a week, then daily, then monthly."}
                {policy === "all" && "Never prunes — every saved version is kept forever (uses the most storage)."}
                {policy === "days" && "Keeps every version from the last N days and prunes anything older."}
              </p>
            </div>

            {policy === "days" && (
              <div className="flex shrink-0 items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  value={days}
                  onChange={(e) => setDays(Math.floor(Number(e.target.value)))}
                  className="w-24"
                />
                <span className="text-[13px] text-muted-foreground">days</span>
              </div>
            )}

            {policyError && <p className="shrink-0 text-[12.5px] text-destructive">{policyError}</p>}

            <Button
              size="sm"
              className="shrink-0 self-start"
              disabled={savingPolicy || !policyDirty || !daysValid}
              onClick={() => void savePolicy()}
            >
              {savingPolicy ? "Saving…" : "Save"}
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
