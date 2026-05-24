import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { PluginSettingsDialog } from "@/components/plugin-settings-dialog";
import { getPluginSettings, listAiModels, listProcessing, type AiModel, type ProcessingRun } from "@/lib/api";

function fmtWhen(iso: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/**
 * Recent processing runs across the user's files, newest first — the per-document
 * log surfaced on the plugin page (the per-file copy lives in each file's details).
 */
function ActivityFeed() {
  const [runs, setRuns] = useState<ProcessingRun[] | null>(null);

  useEffect(() => {
    let alive = true;
    listProcessing("document-ai", 50)
      .then((r) => alive && setRuns(r))
      .catch(() => alive && setRuns([]));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div>
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Recent activity</div>
      {runs == null ? (
        <div className="text-[12.5px] text-muted-foreground">Loading…</div>
      ) : runs.length === 0 ? (
        <div className="rounded-lg border border-dashed p-4 text-[12.5px] text-muted-foreground">
          No documents processed yet. Add a file and it'll appear here.
        </div>
      ) : (
        <div className="flex flex-col">
          {runs.map((r, i) => {
            const summary =
              r.status === "error"
                ? (r.note ?? "Failed")
                : [r.labels?.length ? r.labels.join(", ") : null, r.described ? "description" : null]
                    .filter(Boolean)
                    .join(" · ") || "No changes";
            return (
              <div key={`${r.fileId}:${r.at}:${i}`} className="flex items-start gap-2.5 border-b py-2 last:border-0">
                <span
                  className={`mt-1.5 size-2 shrink-0 rounded-full ${r.status === "error" ? "bg-destructive" : "bg-primary"}`}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-[13px] font-medium">{r.fileName}</span>
                    <span className="ml-auto shrink-0 font-mono text-[11.5px] text-muted-foreground">{fmtWhen(r.at)}</span>
                  </div>
                  <div className={`text-[12.5px] ${r.status === "error" ? "text-destructive" : "text-muted-foreground"}`}>
                    {summary}
                    {r.spaceName ? <span className="text-muted-foreground"> · {r.spaceName}</span> : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Document AI: a server-side processor that, for each newly-added document, asks the
 * host's AI gateway to write a type label and a short description into the file's
 * metadata (in the language set in Settings) and records the run in the file's
 * processing log. The model is whichever the deployment exposes — Gemma via Workers
 * AI on Cloudflare (no key), Gemini, or a local model. This view shows whether a
 * model is available + which one is in use, and opens the (generic) settings dialog.
 */
export function DocumentAiView() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [state, setState] = useState<{ models: AiModel[]; selected?: string; loading: boolean }>({
    models: [],
    loading: true,
  });

  const load = useCallback(async () => {
    const [models, settings] = await Promise.all([listAiModels(), getPluginSettings("document-ai")]);
    setState({ models, selected: settings?.values.model || undefined, loading: false });
  }, []);

  useEffect(() => {
    let alive = true;
    void load().catch(() => alive && setState({ models: [], loading: false }));
    return () => {
      alive = false;
    };
  }, [load]);

  const configured = state.models.length > 0;
  const activeModel = state.models.find((m) => m.id === state.selected) ?? state.models[0];

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-5 py-2">
      <div className="flex items-center gap-3">
        <div className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary">
          <Icon name="sparkles" size={22} />
        </div>
        <div className="flex-1">
          <div className="text-[16px] font-semibold">Document AI</div>
          <div className="text-[13px] text-muted-foreground">
            Labels each document you add (Invoice, Receipt, Contract…) and writes a short description, using
            an AI model the host provides.
          </div>
        </div>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setSettingsOpen(true)}>
          <Icon name="settings" size={15} /> Settings
        </Button>
      </div>

      {state.loading ? (
        <div className="text-[13px] text-muted-foreground">Checking…</div>
      ) : configured ? (
        <div className="flex items-center gap-2 rounded-lg border bg-card px-3.5 py-2.5 text-[13px]">
          <span className="size-2 rounded-full bg-primary" />
          <span>
            Connected — new uploads are processed automatically
            {activeModel ? (
              <>
                {" "}
                with <span className="font-medium">{activeModel.label}</span>
              </>
            ) : null}
            . Labels, description, and a processing log appear in a file's details.
          </span>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed p-5 text-[13px] text-muted-foreground">
          No AI model is available. Deploy on{" "}
          <span className="font-medium text-foreground">Cloudflare</span> (Gemma runs through Workers AI with
          no API key), or configure a provider on the server, then pick a model in{" "}
          <span className="font-medium text-foreground">Settings</span>.
        </div>
      )}

      <div className="rounded-lg bg-muted/60 p-3 text-[12.5px] leading-relaxed text-muted-foreground">
        Processing runs in the background when a file is added, so it never slows an upload. It reads the
        file's content (text, or the PDF/image itself) once to label and describe it; only the resulting
        label and description are stored. Set the output language in Settings.
      </div>

      {!state.loading && configured && <ActivityFeed />}

      <PluginSettingsDialog
        pluginId="document-ai"
        pluginName="Document AI"
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onSaved={() => void load()}
      />
    </div>
  );
}
