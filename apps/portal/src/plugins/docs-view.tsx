import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
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

/**
 * Docs plugin detail view. Reads markdown from the `docs` storage mount via the
 * host API (the plugin's declared storage:read capability) and renders it.
 */
export function DocsView() {
  const [docs, setDocs] = useState<FileItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listMount("", "docs")
      .then((items) => {
        const md = items.filter((f) => f.kind !== "folder" && /\.md$/i.test(f.name));
        setDocs(md);
        setSelected((s) => s ?? md[0]?.path ?? null);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!selected) return;
    readText(selected, "docs")
      .then(setContent)
      .catch((err: Error) => setError(err.message));
  }, [selected]);

  if (error) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        Couldn't load docs. Is the API running and is there a <code className="font-mono">docs/</code> folder?
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
        {docs.length === 0 && <div className="px-2 text-[13px] text-muted-foreground">No docs yet.</div>}
      </nav>

      <article className="prose prose-sm dark:prose-invert max-w-[680px] prose-headings:tracking-tight prose-pre:bg-muted prose-pre:text-foreground prose-code:before:content-none prose-code:after:content-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </article>
    </div>
  );
}
