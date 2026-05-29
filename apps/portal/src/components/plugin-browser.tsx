import { useState } from "react";
import { Check, Sparkles } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { PLUGIN_CATALOG, type CatalogItem, type PluginGroup } from "@/lib/mock-data";
import type { CustomPlugin } from "@/lib/api";

// Derived from the catalog so any category a plugin declares (e.g. Media for the
// image viewer) shows up as a filter chip without hand-maintaining this list.
const CATEGORIES = ["All", ...Array.from(new Set(PLUGIN_CATALOG.map((p) => p.category)))];

interface PluginBrowserProps {
  installedIds: string[];
  onInstall: (id: string) => void;
  onUninstall: (id: string) => void;
  /** Open a plugin's settings (config + which places it applies to). */
  onConfigure?: (id: string) => void;
  /** Open the "Build your own plugin with AI" page. Only shown in the full browser. */
  onBuildWithAI?: () => void;
  /** The caller's Plugin Studio creations, listed as "Your plugins" in the full browser. */
  custom?: CustomPlugin[];
  /** Launch a custom app plugin (those with a navigable detailView). */
  onOpenCustom?: (id: string) => void;
  /** Uninstall (delete) a custom plugin. */
  onUninstallCustom?: (id: string) => void;
  /**
   * Restrict to one plugin group. When set, the browser drops its search box,
   * category chips and the build-with-AI banner — it becomes a focused list for a
   * Settings tab (AI, Connectors). Omit it for the full catalog (the Plugins tab).
   */
  group?: PluginGroup;
}

/**
 * The catalog browser: search + category chips + an install/configure grid. Used as
 * the Settings → Plugins tab (full catalog) and, with a `group` filter, as the
 * shortlist inside the AI and Connectors tabs.
 */
export function PluginBrowser({
  installedIds,
  onInstall,
  onUninstall,
  onConfigure,
  onBuildWithAI,
  custom,
  onOpenCustom,
  onUninstallCustom,
  group,
}: PluginBrowserProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const full = !group;

  const items = PLUGIN_CATALOG.filter((p) => {
    if (group) return (p.group ?? "general") === group;
    return (
      (category === "All" || p.category === category) &&
      (p.label.toLowerCase().includes(query.toLowerCase()) ||
        p.tagline.toLowerCase().includes(query.toLowerCase()))
    );
  });

  return (
    <div className="flex flex-col gap-4">
      {full && (
        <div className="flex flex-col gap-3">
          <Input placeholder="Search plugins…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="flex flex-wrap gap-1.5">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={cn(
                  "rounded-full px-3 py-1 text-[12.5px] font-medium transition-colors",
                  category === c
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-secondary-foreground hover:bg-secondary/70",
                )}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      )}

      {full && onBuildWithAI && (
        <button
          onClick={onBuildWithAI}
          className="flex items-center gap-3 rounded-lg border border-dashed p-3.5 text-left transition-colors hover:bg-accent"
        >
          <div
            className="grid size-11 shrink-0 place-items-center rounded-md"
            style={{ background: "hsl(262 60% 55% / 0.14)", color: "hsl(262 60% 55%)" }}
          >
            <Sparkles size={20} />
          </div>
          <div className="min-w-0">
            <div className="font-medium">Build your own with AI</div>
            <div className="text-[12.5px] text-muted-foreground">
              Can't find it? Describe your idea and let an AI agent write the plugin.
            </div>
          </div>
          <Icon name="chevron-right" size={18} className="ml-auto shrink-0 text-muted-foreground" />
        </button>
      )}

      {full && custom && custom.length > 0 && (
        <section className="flex flex-col gap-3">
          <div>
            <h3 className="text-[13px] font-semibold">Your plugins</h3>
            <p className="text-[12px] text-muted-foreground">
              Generated in Plugin Studio and installed for your account.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {custom.map((p) => (
              <CustomPluginCard
                key={p.id}
                plugin={p}
                onOpen={onOpenCustom}
                onUninstall={onUninstallCustom}
              />
            ))}
          </div>
        </section>
      )}

      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-[13px] text-muted-foreground">
          No plugins here yet.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {items.map((p) => (
            <PluginCard
              key={p.id}
              plugin={p}
              installed={installedIds.includes(p.id)}
              onInstall={onInstall}
              onUninstall={onUninstall}
              onConfigure={onConfigure}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PluginCard({
  plugin: p,
  installed,
  onInstall,
  onUninstall,
  onConfigure,
}: {
  plugin: CatalogItem;
  installed: boolean;
  onInstall: (id: string) => void;
  onUninstall: (id: string) => void;
  onConfigure?: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border p-3.5">
      <div className="flex items-start justify-between">
        <div
          className="grid size-11 place-items-center rounded-md"
          style={{ background: `hsl(${p.color} / 0.14)`, color: `hsl(${p.color})` }}
        >
          <Icon name={p.icon} size={20} />
        </div>
        {p.popular && (
          <Badge variant="secondary" className="text-[10px]">
            Popular
          </Badge>
        )}
      </div>
      <div>
        <div className="font-medium">{p.label}</div>
        <div className="text-[11.5px] text-muted-foreground">{p.category}</div>
      </div>
      <p className="flex-1 text-[13px] leading-[1.45] text-muted-foreground">{p.tagline}</p>
      <div className="flex items-center gap-1.5">
        {installed ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onUninstall(p.id)}
            className="group/btn flex-1 gap-1.5"
            title="Click to uninstall"
          >
            <Check size={14} className="group-hover/btn:hidden" />
            <span className="group-hover/btn:hidden">Installed</span>
            <span className="hidden group-hover/btn:inline">Uninstall</span>
          </Button>
        ) : (
          <Button variant="outline" size="sm" className="flex-1" onClick={() => onInstall(p.id)}>
            Install
          </Button>
        )}
        {onConfigure && (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground"
            title="Settings & places"
            aria-label={`${p.label} settings`}
            onClick={() => onConfigure(p.id)}
          >
            <Icon name="settings" size={16} />
          </Button>
        )}
      </div>
    </div>
  );
}

/** A card for a Plugin Studio creation: launch it (if it's an app) or uninstall it. */
function CustomPluginCard({
  plugin,
  onOpen,
  onUninstall,
}: {
  plugin: CustomPlugin;
  onOpen?: (id: string) => void;
  onUninstall?: (id: string) => void;
}) {
  const m = plugin.manifest;
  const app = m.contributes?.detailView;
  const matches = [...new Set((m.contributes?.viewers ?? []).flatMap((v) => v.match))];
  const subtitle = app?.nav?.section
    ? `App · ${app.nav.section}`
    : matches.length
      ? `Opens ${matches.slice(0, 3).join(", ")}`
      : "Plugin";
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border p-3.5">
      <div className="flex items-start justify-between">
        <div
          className="grid size-11 place-items-center rounded-md"
          style={{
            background: `hsl(${m.color ?? "262 60% 55%"} / 0.14)`,
            color: `hsl(${m.color ?? "262 60% 55%"})`,
          }}
        >
          <Icon name={m.icon ?? "plugin"} size={20} />
        </div>
        <Badge variant="secondary" className="text-[10px]">
          Yours
        </Badge>
      </div>
      <div>
        <div className="font-medium">{m.name}</div>
        <div className="text-[11.5px] text-muted-foreground">{subtitle}</div>
      </div>
      {m.description && (
        <p className="flex-1 text-[13px] leading-[1.45] text-muted-foreground">{m.description}</p>
      )}
      <div className="flex items-center gap-1.5">
        {app && onOpen && (
          <Button variant="outline" size="sm" className="flex-1" onClick={() => onOpen(plugin.id)}>
            Open
          </Button>
        )}
        {onUninstall && (
          <Button
            variant="ghost"
            size="sm"
            className={cn("gap-1.5 text-muted-foreground hover:text-destructive", !app && "flex-1")}
            onClick={() => onUninstall(plugin.id)}
          >
            <Icon name="trash" size={14} /> Uninstall
          </Button>
        )}
      </div>
    </div>
  );
}
