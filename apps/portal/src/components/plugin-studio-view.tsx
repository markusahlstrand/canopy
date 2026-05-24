import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Sparkles, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Icon } from "@/lib/icons";
import { PluginViewer } from "@/components/plugin-viewer";
import { BuildPluginView } from "@/components/build-plugin-view";
import { aiGenerate, listAiModels, saveCustomPlugin, type AiModel, type CustomPlugin } from "@/lib/api";
import {
  buildGenerationMessages,
  parseGeneratedPlugin,
  type GeneratedPlugin,
} from "@/lib/plugin-author-prompt";

/**
 * Plugin Studio — describe an idea, the **core LLM** writes a sandboxed viewer
 * plugin, preview it live against a sample file, then install it (persisted +
 * activated for the caller). The whole loop runs in-app: no external coding agent.
 *
 * Graceful fallback: with no AI model configured for the account, this degrades
 * to the prompt-copier ({@link BuildPluginView}) — the "drive an external agent"
 * path — so the feature is still useful without an LLM.
 */
export function PluginStudioView({
  existing = [],
  onInstalled,
  onDelete,
}: {
  /** The caller's already-generated plugins, for the management list. */
  existing?: CustomPlugin[];
  onInstalled?: () => void;
  onDelete?: (id: string) => void;
}) {
  const [models, setModels] = useState<AiModel[] | null>(null); // null = still loading
  const [model, setModel] = useState("");
  const [idea, setIdea] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<GeneratedPlugin | null>(null);
  const [installed, setInstalled] = useState(false);
  const [sample, setSample] = useState<{ name: string; url: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listAiModels().then((m) => {
      setModels(m);
      if (m[0]) setModel(m[0].id);
    });
  }, []);

  // Release the sample's object URL when it's replaced or the view unmounts.
  useEffect(() => {
    return () => {
      if (sample) URL.revokeObjectURL(sample.url);
    };
  }, [sample]);

  async function generate() {
    setBusy(true);
    setError(null);
    setInstalled(false);
    setGenerated(null);
    try {
      const text = await aiGenerate({
        messages: buildGenerationMessages(idea),
        model: model || undefined,
        json: true,
        maxTokens: 4096,
      });
      setGenerated(parseGeneratedPlugin(text));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function install() {
    if (!generated) return;
    setBusy(true);
    setError(null);
    try {
      await saveCustomPlugin(generated.manifest, generated.source);
      setInstalled(true);
      onInstalled?.();
      toast("Plugin installed", { description: `“${generated.manifest.name}” is now active.` });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function pickSample(f: File | undefined) {
    if (!f) return;
    setSample((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return { name: f.name, url: URL.createObjectURL(f) };
    });
  }

  // No LLM available → fall back to the copy-paste prompt path.
  if (models !== null && models.length === 0) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 py-1">
        <div className="rounded-lg border border-dashed bg-muted/40 p-3.5 text-[13px] text-muted-foreground">
          <span className="font-medium text-foreground">No AI model is configured for your account.</span>{" "}
          Add a provider in Settings → AI to generate plugins in-app. For now, here's a ready-to-paste
          prompt for an external coding agent.
        </div>
        <BuildPluginView />
      </div>
    );
  }

  const m = generated?.manifest;
  const viewers = m?.contributes?.viewers ?? [];
  const matches = [...new Set(viewers.flatMap((v) => v.match))];
  const caps = (m?.capabilities ?? []).map((c) => c.kind);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 py-1">
      {/* Header */}
      <div className="flex items-start gap-3.5">
        <div
          className="grid size-11 shrink-0 place-items-center rounded-md"
          style={{ background: "hsl(262 60% 55% / 0.14)", color: "hsl(262 60% 55%)" }}
        >
          <Sparkles size={20} />
        </div>
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Plugin Studio</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Describe a file viewer. The AI writes it, you preview it live, then install it — all
            in-app. It runs in the same sandbox as every other plugin.
          </p>
        </div>
      </div>

      {/* Idea + model */}
      <div className="flex flex-col gap-2">
        <label htmlFor="studio-idea" className="text-[13px] font-medium">
          What should it do?
        </label>
        <textarea
          id="studio-idea"
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          rows={3}
          placeholder="e.g. Render .gpx GPS tracks on a small map, or show EXIF metadata for photos"
          className="w-full resize-y rounded-md border bg-transparent px-3 py-2 text-[14px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex flex-wrap items-center gap-2">
          {models && models.length > 1 && (
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger className="h-9 w-auto min-w-[200px]">
                <SelectValue placeholder="Model" />
              </SelectTrigger>
              <SelectContent>
                {models.map((mo) => (
                  <SelectItem key={mo.id} value={mo.id}>
                    {mo.label} · {mo.provider}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button onClick={generate} disabled={busy || !idea.trim() || models === null} className="gap-1.5">
            {busy && !generated ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
            {busy && !generated ? "Generating…" : generated ? "Regenerate" : "Generate plugin"}
          </Button>
          <span className="text-[12px] text-muted-foreground">
            Today the studio builds sandboxed file viewers.
          </span>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">
          {error}
        </div>
      )}

      {/* Result */}
      {m && (
        <div className="flex flex-col gap-4 rounded-lg border p-4">
          {/* Manifest summary */}
          <div className="flex items-start gap-3">
            <div
              className="grid size-10 shrink-0 place-items-center rounded-md"
              style={{ background: `hsl(${m.color ?? "262 60% 55%"} / 0.14)`, color: `hsl(${m.color ?? "262 60% 55%"})` }}
            >
              <Icon name={m.icon ?? "plugin"} size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {m.name} <span className="font-mono text-[12px] text-muted-foreground">{m.id}</span>
              </div>
              {m.description && <p className="text-[12.5px] text-muted-foreground">{m.description}</p>}
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {matches.map((mt) => (
                  <code key={mt} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                    {mt}
                  </code>
                ))}
                {caps.map((c) => (
                  <span
                    key={c}
                    className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground"
                  >
                    {c}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Live preview */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-medium">Live preview</span>
              <input
                ref={fileInput}
                type="file"
                className="hidden"
                onChange={(e) => pickSample(e.target.files?.[0] ?? undefined)}
              />
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => fileInput.current?.click()}>
                <Upload size={14} /> {sample ? "Change sample" : "Choose a sample file"}
              </Button>
            </div>
            {sample ? (
              <PluginViewer
                key={sample.url}
                file={{ source: generated!.source, name: sample.name, url: sample.url }}
              />
            ) : (
              <div className="grid h-32 place-items-center rounded-lg border-2 border-dashed text-center text-[12.5px] text-muted-foreground">
                Pick a sample file matching {matches.slice(0, 3).join(", ") || "the viewer"} to preview it here.
              </div>
            )}
          </div>

          {/* Source */}
          <details className="rounded-md border bg-muted/30">
            <summary className="cursor-pointer select-none px-3 py-2 text-[12.5px] font-medium">
              View generated source ({generated!.source.length.toLocaleString()} chars)
            </summary>
            <pre className="overflow-x-auto px-3 pb-3 font-mono text-[11.5px] leading-[1.5]">
              {generated!.source}
            </pre>
          </details>

          {/* Install */}
          <div className="flex items-center gap-2">
            <Button onClick={install} disabled={busy || installed} className="gap-1.5">
              {installed ? <Check size={15} /> : busy ? <Loader2 size={15} className="animate-spin" /> : <Icon name="plugin" size={15} />}
              {installed ? "Installed" : "Install plugin"}
            </Button>
            {installed && (
              <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                Active now — open a matching file's preview to use it.
              </span>
            )}
          </div>
        </div>
      )}

      {/* Manage already-generated plugins */}
      {existing.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-medium">Your generated plugins</span>
          <div className="flex flex-col divide-y rounded-lg border">
            {existing.map((p) => {
              const ms = [...new Set((p.manifest.contributes?.viewers ?? []).flatMap((v) => v.match))];
              return (
                <div key={p.id} className="flex items-center gap-3 px-3.5 py-2.5">
                  <div
                    className="grid size-8 shrink-0 place-items-center rounded-md"
                    style={{
                      background: `hsl(${p.manifest.color ?? "262 60% 55%"} / 0.14)`,
                      color: `hsl(${p.manifest.color ?? "262 60% 55%"})`,
                    }}
                  >
                    <Icon name={p.manifest.icon ?? "plugin"} size={15} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{p.manifest.name}</div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">{ms.join(", ")}</div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 text-muted-foreground hover:text-destructive"
                    onClick={() => onDelete?.(p.id)}
                  >
                    <Trash2 size={14} /> Uninstall
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
