import { useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/lib/icons";

/**
 * "Build your own plugin with AI" — a guided prompt generator.
 *
 * There's no runtime plugin upload yet, so this doesn't load code in the browser.
 * Instead it turns a one-line idea into a ready-to-paste prompt for a coding agent
 * (Claude Code, Cursor, …) that follows the in-repo authoring spec
 * (documentation/08-build-a-plugin-with-ai.md). The fastest path is the bundled
 * Claude Code skill: `/new-plugin "<idea>"`.
 */

const SPEC = "documentation/08-build-a-plugin-with-ai.md";
const SCHEMA = "documentation/canopy-plugin.schema.json";
const VIEWERS = "apps/portal/src/plugins/viewers.ts";

function buildPrompt(idea: string): string {
  const desc = idea.trim() || "<describe your plugin, e.g. render .gpx GPS tracks on a small map>";
  return `Build a Canopy file-viewer plugin: ${desc}

Follow ${SPEC} exactly. Specifically:
- Create examples/plugins/<id>/canopy.json (valid against ${SCHEMA})
  and examples/plugins/<id>/index.js (export default render(ctx)).
- The entry runs in an opaque-origin sandboxed iframe: you get only ctx.file
  (name, mime, bytes, writable) and ctx.container — no host DOM/cookies/storage,
  inline styles only. CDN import() is allowed but must degrade gracefully.
- Register it in ${VIEWERS} (a ?raw import + a VIEWERS entry; put specific
  matchers before broad ones).
- Use the minimal capabilities. Then tell me which file type to drop to test it.`;
}

const STEPS: { icon: string; title: string; body: string }[] = [
  {
    icon: "sparkles",
    title: "Describe it",
    body: "One line: what file type it shows and what it does. Be specific about the extension or MIME.",
  },
  {
    icon: "plugin",
    title: "Run the skill (or paste the prompt)",
    body: "In Claude Code, run /new-plugin with your idea — it scaffolds, writes, and wires the plugin. No Claude Code? Copy the prompt below into any coding agent.",
  },
  {
    icon: "upload",
    title: "Restart & preview",
    body: "Run pnpm dev, then upload a matching file and open its preview. Your viewer renders in the sandbox; a failure shows the error inline.",
  },
];

export function BuildPluginView() {
  const [idea, setIdea] = useState("");
  const [copied, setCopied] = useState(false);
  const prompt = useMemo(() => buildPrompt(idea), [idea]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable — user can select the text manually */
    }
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 py-1">
      {/* Header */}
      <div className="flex items-start gap-3.5">
        <div
          className="grid size-11 shrink-0 place-items-center rounded-md"
          style={{ background: "hsl(262 60% 55% / 0.14)", color: "hsl(262 60% 55%)" }}
        >
          <Icon name="sparkles" size={20} />
        </div>
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Build your own plugin</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Go from an idea to a working file viewer in minutes — an AI agent writes it, following
            Canopy's authoring spec.
          </p>
        </div>
      </div>

      {/* Steps */}
      <div className="grid gap-3 sm:grid-cols-3">
        {STEPS.map((s, i) => (
          <div key={s.title} className="flex flex-col gap-2 rounded-lg border p-3.5">
            <div className="flex items-center gap-2">
              <div className="grid size-7 place-items-center rounded-md bg-secondary text-secondary-foreground">
                <Icon name={s.icon} size={15} />
              </div>
              <span className="font-mono text-[11px] text-muted-foreground">Step {i + 1}</span>
            </div>
            <div className="text-[13.5px] font-medium">{s.title}</div>
            <p className="text-[12.5px] leading-[1.45] text-muted-foreground">{s.body}</p>
          </div>
        ))}
      </div>

      {/* Idea input */}
      <div className="flex flex-col gap-2">
        <label htmlFor="plugin-idea" className="text-[13px] font-medium">
          Describe your plugin
        </label>
        <textarea
          id="plugin-idea"
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          rows={3}
          placeholder="e.g. Render .gpx GPS tracks on a small map, or show EXIF metadata for photos"
          className="w-full resize-y rounded-md border bg-transparent px-3 py-2 text-[14px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      {/* Generated prompt */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium">Ready-to-paste prompt</span>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={copy}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-4 font-mono text-[12px] leading-[1.55] text-foreground">
          {prompt}
        </pre>
        <p className="text-[12.5px] text-muted-foreground">
          Using Claude Code? Skip the copy — just run{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11.5px]">
            /new-plugin {idea.trim() ? `"${idea.trim()}"` : '"your idea"'}
          </code>{" "}
          and it does all of this for you.
        </p>
      </div>

      {/* Footer / docs */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-dashed p-3.5 text-[12.5px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
          <Icon name="book" size={14} /> Learn the contract
        </span>
        <code className="font-mono">{SPEC}</code>
        <span className="opacity-50">·</span>
        <code className="font-mono">{SCHEMA}</code>
        <span className="opacity-50">·</span>
        <span>Today this builds sandboxed file viewers — the kind that runs with no host rewrite.</span>
      </div>
    </div>
  );
}
