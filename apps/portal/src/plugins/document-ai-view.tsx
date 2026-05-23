import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { PluginSettingsDialog } from "@/components/plugin-settings-dialog";
import { getPluginSettings } from "@/lib/api";

/**
 * Document AI: a server-side processor that classifies each newly-added document
 * with Google Gemini Flash and writes a type label into the file's metadata. This
 * view shows whether the API key is set and opens the (generic) settings dialog.
 */
export function DocumentAiView() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [state, setState] = useState<{ configured: boolean; loading: boolean }>({ configured: false, loading: true });

  const load = useCallback(async () => {
    const s = await getPluginSettings("document-ai");
    setState({ configured: !!s?.secretsSet.includes("apiKey"), loading: false });
  }, []);

  useEffect(() => {
    let alive = true;
    void load().catch(() => alive && setState({ configured: false, loading: false }));
    return () => {
      alive = false;
    };
  }, [load]);

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-5 py-2">
      <div className="flex items-center gap-3">
        <div className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary">
          <Icon name="sparkles" size={22} />
        </div>
        <div className="flex-1">
          <div className="text-[16px] font-semibold">Document AI</div>
          <div className="text-[13px] text-muted-foreground">
            Classifies each document you add (Invoice, Receipt, Contract…) with Gemini Flash and tags it.
          </div>
        </div>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setSettingsOpen(true)}>
          <Icon name="settings" size={15} /> Settings
        </Button>
      </div>

      {state.loading ? (
        <div className="text-[13px] text-muted-foreground">Checking…</div>
      ) : state.configured ? (
        <div className="flex items-center gap-2 rounded-lg border bg-card px-3.5 py-2.5 text-[13px]">
          <span className="size-2 rounded-full bg-primary" />
          Connected — new uploads are labeled automatically. Labels appear in a file's details.
        </div>
      ) : (
        <div className="rounded-lg border border-dashed p-5 text-[13px] text-muted-foreground">
          Add a <span className="font-medium text-foreground">Google AI API key</span> in{" "}
          <span className="font-medium text-foreground">Settings</span> to start labeling. Get one from
          Google AI Studio. The key is encrypted and never leaves the server.
        </div>
      )}

      <div className="rounded-lg bg-muted/60 p-3 text-[12.5px] leading-relaxed text-muted-foreground">
        Labeling runs in the background when a file is added, so it never slows an upload. It reads the
        file's content (text, or the PDF/image itself) once to classify it; only the resulting label is
        stored.
      </div>

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
