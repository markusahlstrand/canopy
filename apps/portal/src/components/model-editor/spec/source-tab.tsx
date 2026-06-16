import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { SourceFile } from "./graph-types";
import type { SpecViewProps } from "./view-types";

/** A request to reveal a specific line; nonce re-triggers even for a repeat target. */
export interface RevealTarget {
  file: string;
  line?: number;
  nonce: number;
}

const KIND_ICON: Record<SourceFile["kind"], string> = { tsp: "file-code", openapi: "globe", arazzo: "board" };
const KIND_LABEL: Record<SourceFile["kind"], string> = { tsp: "TypeSpec", openapi: "OpenAPI", arazzo: "Arazzo" };

const basename = (p: string) => p.replace(/[#?].*$/, "").split("/").pop()!.trim();

type Seg = { text: string } | { text: string; onClick: () => void; title: string };

/**
 * Reads the raw text of every discovered file and makes the references between them
 * navigable: `import`/`url`/`x-typespec-source` jump to the referenced file here;
 * an `operationId` jumps to the Endpoints tab. This is the "complete view" — the
 * three projection tabs plus the canonical source they're built from.
 */
export function SourceTab({ graph, onNavigate, reveal }: SpecViewProps & { reveal?: RevealTarget | null }) {
  const files = graph.sourceFiles;
  const [activeName, setActiveName] = useState(() => files[0]?.name ?? "");
  const active = files.find((f) => f.name === activeName) ?? files[0];
  const scrollRef = useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState<number | null>(null);

  // Respond to a "View source" jump: switch file, scroll the line into view, flash it.
  useEffect(() => {
    if (!reveal) return;
    setActiveName(reveal.file);
    setHighlight(reveal.line ?? null);
    const scrollT = setTimeout(() => {
      const el = scrollRef.current?.querySelector(`[data-line="${reveal.line}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 60);
    const clearT = setTimeout(() => setHighlight(null), 2400);
    return () => {
      clearTimeout(scrollT);
      clearTimeout(clearT);
    };
  }, [reveal?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const fileByBase = useMemo(() => new Map(files.map((f) => [basename(f.name), f])), [files]);
  const knownOps = useMemo(() => new Set(graph.endpoints.map((e) => e.operationId)), [graph.endpoints]);

  /** Split one line into plain text + clickable cross-document references. */
  const linkify = useMemo(() => {
    return (line: string): Seg[] => {
      const find = (s: string): { start: number; end: number; seg: Seg } | null => {
        const cands: { start: number; end: number; seg: Seg }[] = [];
        const push = (idx: number, len: number, seg: Seg) => idx >= 0 && cands.push({ start: idx, end: idx + len, seg });
        // import "..."  /  url: ./x  /  x-typespec-source: ./x
        for (const re of [/\bimport\s+"([^"]+)"/g, /\b(?:url|x-typespec-source)\s*:\s*"?([^\s"]+)"?/g]) {
          for (const m of s.matchAll(re)) {
            const path = m[1]!;
            const target = fileByBase.get(basename(path));
            if (!target) continue;
            const idx = m.index! + m[0].indexOf(path);
            push(idx, path.length, { text: path, title: `Open ${target.name}`, onClick: () => setActiveName(target.name) });
          }
        }
        // operationId references (TypeSpec @operationId("x"), arazzo/openapi operationId: x)
        for (const m of s.matchAll(/\boperationId\b\s*[(:\s]*"?([A-Za-z_][A-Za-z0-9_]*)/g)) {
          const id = m[1]!;
          if (!knownOps.has(id)) continue;
          const idx = m.index! + m[0].lastIndexOf(id);
          push(idx, id.length, { text: id, title: `Go to endpoint ${id}`, onClick: () => onNavigate({ kind: "endpoint", id }) });
        }
        return cands.sort((a, b) => a.start - b.start)[0] ?? null;
      };

      const segs: Seg[] = [];
      let rest = line;
      let guard = 0;
      while (rest && guard++ < 50) {
        const hit = find(rest);
        if (!hit) break;
        if (hit.start > 0) segs.push({ text: rest.slice(0, hit.start) });
        segs.push(hit.seg);
        rest = rest.slice(hit.end);
      }
      if (rest) segs.push({ text: rest });
      return segs.length ? segs : [{ text: line }];
    };
  }, [fileByBase, knownOps, onNavigate]);

  const lines = useMemo(() => (active ? active.text.split("\n") : []), [active]);

  if (!files.length) {
    return <div className="grid h-full place-items-center text-sm text-muted-foreground">No source files discovered.</div>;
  }

  return (
    <div className="flex h-full min-h-0">
      {/* File list */}
      <div className="w-56 shrink-0 overflow-y-auto border-r bg-muted/20 py-2">
        {(["tsp", "openapi", "arazzo"] as const).map((kind) => {
          const group = files.filter((f) => f.kind === kind);
          if (!group.length) return null;
          return (
            <div key={kind} className="mb-2">
              <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{KIND_LABEL[kind]}</div>
              {group.map((f) => (
                <button
                  key={f.name}
                  onClick={() => setActiveName(f.name)}
                  className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition hover:bg-accent", f.name === active?.name && "bg-accent font-medium")}
                >
                  <Icon name={KIND_ICON[f.kind]} size={13} className="shrink-0 text-muted-foreground" />
                  <span className="truncate">{f.name}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>

      {/* Source pane */}
      <div className="flex min-w-0 flex-1 flex-col">
        {active && (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-[12px]">
              <Icon name={KIND_ICON[active.kind]} size={13} className="text-muted-foreground" />
              <span className="font-mono font-semibold">{active.name}</span>
              <span className="ml-auto font-mono text-[10px] text-muted-foreground">{lines.length} lines · click imports & operationIds to follow</span>
            </div>
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-background">
              <pre className="min-w-full py-2 font-mono text-[12px] leading-[1.5]">
                {lines.map((line, i) => (
                  <div key={i} data-line={i + 1} className={cn("flex transition-colors", highlight === i + 1 ? "bg-primary/15" : "hover:bg-accent/30")}>
                    <span className={cn("sticky left-0 w-12 shrink-0 select-none pr-3 text-right", highlight === i + 1 ? "bg-primary/15 text-primary" : "bg-background text-muted-foreground/50")}>{i + 1}</span>
                    <code className="whitespace-pre px-3">
                      {linkify(line).map((seg, j) =>
                        "onClick" in seg ? (
                          <button key={j} onClick={seg.onClick} title={seg.title} className="rounded-sm bg-primary/10 px-0.5 text-primary underline-offset-2 hover:underline">
                            {seg.text}
                          </button>
                        ) : (
                          <Fragment key={j}>{seg.text || " "}</Fragment>
                        ),
                      )}
                    </code>
                  </div>
                ))}
              </pre>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
