import { Fragment, isValidElement, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { listMount, mountFileUrl, readText } from "@/lib/api";
import type { FileItem } from "@/lib/mock-data";
import { cn } from "@/lib/utils";

/** A page's stable slug: filename without the `NN-` prefix or `.md` extension. */
function slug(name: string): string {
  return name.replace(/\.md$/i, "").replace(/^\d+[-_ ]*/, "");
}

/** Sidebar title for a regular page (slug with dashes → spaces, first letter up). */
function title(name: string): string {
  const base = slug(name).replace(/[-_]/g, " ");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

// Comparison pages are named `compare-<service>.md` and grouped in the nav. Their
// display names need proper casing a generic title-caser can't give (OneDrive…).
const SERVICE_NAMES: Record<string, string> = {
  "google-drive": "Google Drive",
  dropbox: "Dropbox",
  onedrive: "OneDrive",
  "proton-drive": "Proton Drive",
  nextcloud: "Nextcloud",
  owncloud: "ownCloud",
  seafile: "Seafile",
  "pydio-cells": "Pydio Cells",
  filestash: "Filestash",
  synology: "Synology",
  truenas: "TrueNAS",
  minio: "MinIO",
  syncthing: "Syncthing",
  "paperless-ngx": "Paperless-ngx",
};
const isCompare = (name: string) => /^compare-/i.test(slug(name));
function compareLabel(name: string): string {
  const s = slug(name).replace(/^compare-/, "");
  return SERVICE_NAMES[s] ?? s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Comparison pages, grouped and ordered deliberately in the nav (alphabetical
// would scatter related products). Slugs are the `compare-*` filenames; any page
// not listed here still shows, under a trailing "More" group.
const COMPARE_GROUPS: { label: string; slugs: string[] }[] = [
  { label: "Consumer cloud", slugs: ["compare-google-drive", "compare-dropbox", "compare-onedrive", "compare-proton-drive"] },
  { label: "Self-hosted platforms", slugs: ["compare-nextcloud", "compare-owncloud", "compare-seafile", "compare-pydio-cells", "compare-filestash"] },
  { label: "NAS operating systems", slugs: ["compare-synology", "compare-truenas"] },
  { label: "Storage & sync", slugs: ["compare-minio", "compare-syncthing"] },
  { label: "Document management", slugs: ["compare-paperless-ngx"] },
];

// The overview page under which the comparison pages nest (expandable in the nav).
const OVERVIEW_SLUG = "how-it-compares";

// ── URL: the selected page lives in `?doc=<slug>` so it's deep-linkable and
//    survives refresh. The host's App preserves this param while the docs view
//    is open (see urlForState in App.tsx). ────────────────────────────────────
const docParam = () => new URLSearchParams(window.location.search).get("doc") ?? "";
function writeDocParam(s: string, replace = false) {
  const p = new URLSearchParams(window.location.search);
  if (s) p.set("doc", s);
  else p.delete("doc");
  const qs = p.toString();
  const url = window.location.pathname + (qs ? `?${qs}` : "");
  if (replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
}

/** Resolve an in-doc link href to a loaded page, or null if it's external. Handles
 *  bare names (`how-plugins-work`), numbered files (`05-writing-a-plugin.md`), and
 *  `#anchor` / path noise — so cross-doc links navigate in-app instead of reloading. */
function resolveDoc(href: string, docs: FileItem[]): FileItem | null {
  if (/^([a-z]+:|\/|#|mailto:)/i.test(href)) return null; // absolute, protocol, anchor-only
  const ref = href.split("#")[0].split("?")[0].split("/").pop() ?? "";
  if (!ref) return null;
  const want = slug(ref);
  return docs.find((d) => slug(d.name) === want) ?? null;
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
      <div className="not-prose grid h-24 place-items-center text-[12px] text-muted-foreground">Rendering diagram…</div>
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

/**
 * Documentation plugin detail view. Reads markdown from the `documentation`
 * storage mount via the host API (the plugin's declared storage:read capability)
 * and renders it — including ```mermaid diagrams. The open page is kept in the URL
 * (`?doc=`) so it's deep-linkable and survives a refresh, and in-doc links navigate
 * in-app rather than reloading the SPA.
 */
export function DocumentationView() {
  const [docs, setDocs] = useState<FileItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null); // the page's mount path
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  // null = follow the page (open on the overview / a comparison page); true/false
  // = an explicit user toggle, reset to "follow" on the next navigation.
  const [compareOverride, setCompareOverride] = useState<boolean | null>(null);
  // Mirror the loaded list into a ref for event-time readers (popstate, link
  // clicks) that are captured once and would otherwise see a stale closure.
  const docsRef = useRef<FileItem[]>([]);
  useEffect(() => {
    docsRef.current = docs;
  }, [docs]);

  // Load the page list, then open the page named in `?doc=` (or the first page).
  useEffect(() => {
    listMount("", "documentation")
      .then((items) => {
        const md = items.filter((f) => f.kind !== "folder" && /\.md$/i.test(f.name));
        setDocs(md);
        const want = docParam();
        const initial = (want && md.find((d) => slug(d.name) === want)) || md[0];
        if (initial) {
          setSelected(initial.path ?? null);
          if (!want) writeDocParam(slug(initial.name), true); // reflect default, no history entry
        }
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  // Fetch the selected page's markdown.
  useEffect(() => {
    if (!selected) return;
    readText(selected, "documentation")
      .then(setContent)
      .catch((err: Error) => setError(err.message));
  }, [selected]);

  // Back/forward: re-open whatever page the URL now points at.
  useEffect(() => {
    function onPop() {
      const want = docParam();
      const d = (want && docsRef.current.find((x) => slug(x.name) === want)) || docsRef.current[0];
      if (d?.path) setSelected(d.path);
      setCompareOverride(null); // let the new page drive the tree again
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function open(path: string) {
    setSelected(path);
    const name = docsRef.current.find((d) => d.path === path)?.name;
    if (name) writeDocParam(slug(name));
    setCompareOverride(null); // expansion follows the destination page
    window.scrollTo({ top: 0 });
  }

  // Custom renderers: ```mermaid → diagram, and in-doc links → in-app navigation.
  const components = useMemo<Components>(
    () => ({
      pre({ children }) {
        const child = Array.isArray(children) ? children[0] : children;
        if (isValidElement(child)) {
          const props = child.props as { className?: string; children?: unknown };
          if (/\blanguage-mermaid\b/.test(props.className ?? "")) {
            return <Mermaid code={String(props.children ?? "").replace(/\n$/, "")} />;
          }
        }
        return <pre>{children}</pre>;
      },
      a({ href, children }) {
        const target = href ? resolveDoc(href, docsRef.current) : null;
        if (target?.path) {
          const path = target.path;
          return (
            <a
              href={`?view=plugin:documentation&doc=${slug(target.name)}`}
              onClick={(e) => {
                e.preventDefault();
                open(path);
              }}
            >
              {children}
            </a>
          );
        }
        if (href && /^(https?:|mailto:|#)/i.test(href)) {
          const external = /^https?:/i.test(href);
          return (
            <a href={href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
              {children}
            </a>
          );
        }
        // Unresolved relative link. A plain sibling asset (e.g. the JSON schema)
        // opens from the mount in a new tab; anything else renders inert so a stray
        // click never navigates the SPA away and loses state.
        if (href && !href.includes("/")) {
          return (
            <a href={mountFileUrl(href, "documentation")} target="_blank" rel="noreferrer">
              {children}
            </a>
          );
        }
        return (
          <a href={href} onClick={(e) => e.preventDefault()}>
            {children}
          </a>
        );
      },
    }),
    [],
  );

  if (error) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        Couldn't load documentation. Is the API running and is there a <code className="font-mono">documentation/</code> folder?
        <div className="mt-1 font-mono text-[12px]">{error}</div>
      </div>
    );
  }

  const mainDocs = docs.filter((d) => !isCompare(d.name));
  const compareDocs = docs.filter((d) => isCompare(d.name));
  const compareBySlug = new Map(compareDocs.map((d) => [slug(d.name), d]));
  const groupedSlugs = new Set(COMPARE_GROUPS.flatMap((g) => g.slugs));
  const ungrouped = compareDocs.filter((d) => !groupedSlugs.has(slug(d.name)));
  const navGroups = [
    ...COMPARE_GROUPS.map((g) => ({
      label: g.label,
      items: g.slugs.map((s) => compareBySlug.get(s)).filter((d): d is FileItem => !!d),
    })),
    ...(ungrouped.length ? [{ label: "More", items: ungrouped }] : []),
  ].filter((g) => g.items.length > 0);

  const hasOverview = mainDocs.some((d) => slug(d.name) === OVERVIEW_SLUG);
  const currentDoc = selected ? docs.find((d) => d.path === selected) : undefined;
  const onComparePage = !!currentDoc && (isCompare(currentDoc.name) || slug(currentDoc.name) === OVERVIEW_SLUG);
  const compareOpen = compareOverride ?? onComparePage;

  const navButton = (d: FileItem, label: string) => (
    <button
      key={d.path}
      onClick={() => d.path && open(d.path)}
      className={cn(
        "rounded-md px-2.5 py-1.5 text-left text-[13.5px] transition-colors",
        selected === d.path ? "bg-accent font-medium text-foreground" : "text-foreground/80 hover:bg-accent/60",
      )}
    >
      {label}
    </button>
  );

  // The "How it compares" overview is expandable: it reveals the per-service
  // comparison pages (grouped) nested beneath it, instead of separate nav sections.
  const renderOverview = (d: FileItem) => (
    <Fragment key={d.path}>
      <div
        className={cn(
          "flex items-center rounded-md pr-1 transition-colors",
          selected === d.path ? "bg-accent" : "hover:bg-accent/60",
        )}
      >
        <button
          onClick={() => d.path && open(d.path)}
          className={cn(
            "flex-1 px-2.5 py-1.5 text-left text-[13.5px]",
            selected === d.path ? "font-medium text-foreground" : "text-foreground/80",
          )}
        >
          {title(d.name)}
        </button>
        {compareDocs.length > 0 && (
          <button
            onClick={() => setCompareOverride(!compareOpen)}
            aria-label={compareOpen ? "Collapse comparisons" : "Expand comparisons"}
            aria-expanded={compareOpen}
            className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={cn("transition-transform", compareOpen && "rotate-90")}
            >
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        )}
      </div>
      {compareOpen && compareDocs.length > 0 && (
        <div className="ml-3 mt-0.5 flex flex-col gap-0.5 border-l border-border/60 pl-2">
          {navGroups.map((g) => (
            <Fragment key={g.label}>
              <div className="px-2 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground/80">
                {g.label}
              </div>
              {g.items.map((d2) => navButton(d2, compareLabel(d2.name)))}
            </Fragment>
          ))}
        </div>
      )}
    </Fragment>
  );

  return (
    <div className="grid grid-cols-[220px_1fr] gap-6">
      <nav className="flex flex-col gap-0.5">
        <div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Pages</div>
        {mainDocs.map((d) => (slug(d.name) === OVERVIEW_SLUG ? renderOverview(d) : navButton(d, title(d.name))))}
        {docs.length === 0 && <div className="px-2 text-[13px] text-muted-foreground">No documentation yet.</div>}

        {/* Fallback: if the overview page is missing, don't orphan the comparison pages. */}
        {!hasOverview &&
          navGroups.map((g) => (
            <Fragment key={g.label}>
              <div className="mb-1 mt-4 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {g.label}
              </div>
              {g.items.map((d) => navButton(d, compareLabel(d.name)))}
            </Fragment>
          ))}
      </nav>

      <article className="prose prose-sm dark:prose-invert max-w-[680px] prose-headings:tracking-tight prose-pre:bg-muted prose-pre:text-foreground prose-code:before:content-none prose-code:after:content-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {content}
        </ReactMarkdown>
      </article>
    </div>
  );
}
