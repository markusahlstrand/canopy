import { isValidElement, useEffect, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { listMount, readText } from "@/lib/api";
import type { FileItem } from "@/lib/mock-data";
import { cn } from "@/lib/utils";

function title(name: string): string {
  const base = name
    .replace(/\.md$/i, "")
    .replace(/^\d+[-_ ]*/, "")
    .replace(/[-_]/g, " ");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

// mermaid is ~1MB, so load it lazily (and only once) — the first diagram on a
// page pulls it into its own chunk; pages without diagrams never download it.
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
const loadMermaid = () => (mermaidPromise ??= import("mermaid").then((m) => m.default));

let mermaidSeq = 0;

/** Track the app's `.dark` class (set on <html> by the theme toggle) so diagrams
 *  re-render in the matching mermaid theme. Provider-agnostic on purpose. */
function useIsDark(): boolean {
  const [dark, setDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const el = document.documentElement;
    const update = () => setDark(el.classList.contains("dark"));
    update();
    const mo = new MutationObserver(update);
    mo.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return dark;
}

/** Renders one ```mermaid fenced block to an inline SVG. Falls back to showing
 *  the source (so a bad diagram or an offline mermaid never blanks the page). */
function Mermaid({ code }: { code: string }) {
  const dark = useIsDark();
  const [svg, setSvg] = useState("");
  const [failed, setFailed] = useState(false);
  const idRef = useRef(`mmd-${++mermaidSeq}`);

  useEffect(() => {
    let cancelled = false;
    loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: dark ? "dark" : "default",
          fontFamily: "inherit",
        });
        // Unique id per theme so re-theming doesn't collide with a cached node.
        const { svg } = await mermaid.render(`${idRef.current}-${dark ? "d" : "l"}`, code);
        if (!cancelled) {
          setSvg(svg);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [code, dark]);

  if (failed) {
    return (
      <pre className="not-prose overflow-x-auto rounded-lg border border-dashed bg-muted p-3 text-[12px] leading-relaxed">
        <code>{code}</code>
      </pre>
    );
  }
  if (!svg) {
    return (
      <div className="not-prose grid h-24 place-items-center text-[12px] text-muted-foreground">
        Rendering diagram…
      </div>
    );
  }
  return (
    <div
      className="not-prose my-5 flex justify-center [&_svg]:h-auto [&_svg]:max-w-full"
      // svg is produced by mermaid with securityLevel:"strict" (sanitized).
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

// react-markdown renders a fenced block as <pre><code class="language-…">. We
// intercept at the <pre> level so a mermaid block becomes a diagram instead of a
// code box (returning a <div> from the `code` slot would nest invalidly in <pre>).
const components: Components = {
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children;
    if (isValidElement(child)) {
      const props = child.props as { className?: string; children?: unknown };
      if (/\blanguage-mermaid\b/.test(props.className ?? "")) {
        const code = String(props.children ?? "").replace(/\n$/, "");
        return <Mermaid code={code} />;
      }
    }
    return <pre>{children}</pre>;
  },
};

/**
 * Documentation plugin detail view. Reads markdown from the `documentation`
 * storage mount via the host API (the plugin's declared storage:read
 * capability) and renders it — including ```mermaid diagrams.
 */
export function DocumentationView() {
  const [docs, setDocs] = useState<FileItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listMount("", "documentation")
      .then((items) => {
        const md = items.filter((f) => f.kind !== "folder" && /\.md$/i.test(f.name));
        setDocs(md);
        setSelected((s) => s ?? md[0]?.path ?? null);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!selected) return;
    readText(selected, "documentation")
      .then(setContent)
      .catch((err: Error) => setError(err.message));
  }, [selected]);

  if (error) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        Couldn't load documentation. Is the API running and is there a <code className="font-mono">documentation/</code> folder?
        <div className="mt-1 font-mono text-[12px]">{error}</div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[220px_1fr] gap-6">
      <nav className="flex flex-col gap-0.5">
        <div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Pages
        </div>
        {docs.map((d) => (
          <button
            key={d.path}
            onClick={() => setSelected(d.path!)}
            className={cn(
              "rounded-md px-2.5 py-1.5 text-left text-[13.5px] transition-colors",
              selected === d.path ? "bg-accent font-medium text-foreground" : "text-foreground/80 hover:bg-accent/60",
            )}
          >
            {title(d.name)}
          </button>
        ))}
        {docs.length === 0 && <div className="px-2 text-[13px] text-muted-foreground">No documentation yet.</div>}
      </nav>

      <article className="prose prose-sm dark:prose-invert max-w-[680px] prose-headings:tracking-tight prose-pre:bg-muted prose-pre:text-foreground prose-code:before:content-none prose-code:after:content-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {content}
        </ReactMarkdown>
      </article>
    </div>
  );
}
