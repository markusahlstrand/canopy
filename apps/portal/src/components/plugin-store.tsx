import { useState } from "react";
import { Check, Sparkles } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { PLUGIN_CATALOG } from "@/lib/mock-data";

const CATEGORIES = ["All", "Productivity", "Help"];

interface PluginStoreProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  installedIds: string[];
  onInstall: (id: string) => void;
  onUninstall: (id: string) => void;
  /** Open the "Build your own plugin with AI" page. */
  onBuildWithAI?: () => void;
}

export function PluginStore({ open, onOpenChange, installedIds, onInstall, onUninstall, onBuildWithAI }: PluginStoreProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");

  const items = PLUGIN_CATALOG.filter(
    (p) =>
      (category === "All" || p.category === category) &&
      (p.label.toLowerCase().includes(query.toLowerCase()) ||
        p.tagline.toLowerCase().includes(query.toLowerCase())),
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[640px] max-w-[92vw] gap-0 sm:max-w-[640px]">
        <SheetHeader className="border-b">
          <SheetTitle>Plugin store</SheetTitle>
          <SheetDescription>Plug in only what your family will actually use.</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-3 px-6 py-4">
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

        {onBuildWithAI && (
          <button
            onClick={onBuildWithAI}
            className="mx-6 mb-1 flex items-center gap-3 rounded-lg border border-dashed p-3.5 text-left transition-colors hover:bg-accent"
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

        <div className="grid grid-cols-2 gap-3 overflow-y-auto px-6 pb-6">
          {items.map((p) => {
            const installed = installedIds.includes(p.id);
            return (
              <div key={p.id} className="flex flex-col gap-2.5 rounded-lg border p-3.5">
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
                {installed ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onUninstall(p.id)}
                    className="group/btn gap-1.5"
                    title="Click to uninstall"
                  >
                    <Check size={14} className="group-hover/btn:hidden" />
                    <span className="group-hover/btn:hidden">Installed</span>
                    <span className="hidden group-hover/btn:inline">Uninstall</span>
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => onInstall(p.id)}>
                    Install
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
