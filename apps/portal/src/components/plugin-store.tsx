import { useState } from "react";
import { Check } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { PLUGIN_CATALOG } from "@/lib/mock-data";

const CATEGORIES = ["All", "Productivity", "Finance", "Lifestyle", "Security", "Media", "Wellness"];

interface PluginStoreProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  installedIds: string[];
  onInstall: (id: string) => void;
}

export function PluginStore({ open, onOpenChange, installedIds, onInstall }: PluginStoreProps) {
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
                  <Button variant="secondary" size="sm" disabled className="gap-1.5">
                    <Check size={14} /> Installed
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
