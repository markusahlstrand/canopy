import type { PluginManifest } from "@canopy/core";
import { Icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { PLUGIN_UI } from "@/plugins";
import { sandboxedSlot } from "@/plugins/ui";
import { usePluginCapabilities } from "@/plugins/data";
import { PluginSlot } from "@/components/plugin-slot";

interface PluginRailProps {
  installed: PluginManifest[];
  active: string;
  onChange: (id: string) => void;
}

export function PluginRail({ installed, active, onChange }: PluginRailProps) {
  // Hooks first — must run unconditionally, before the early return below.
  const capabilities = usePluginCapabilities();

  // Only plugins that contribute a rail panel get a tab here.
  const railPlugins = installed.filter((p) => p.contributes?.railPanel);
  if (railPlugins.length === 0) return null;

  const activeManifest = railPlugins.find((p) => p.id === active) ?? railPlugins[0];
  const sandboxed = activeManifest ? sandboxedSlot(activeManifest.id, "railPanel") : undefined;
  const Panel = activeManifest ? PLUGIN_UI[activeManifest.id]?.RailPanel : undefined;

  return (
    <aside className="app-rail flex h-full flex-col border-l bg-card">
      {/* Tab bar */}
      <div className="flex h-14 items-center gap-1 border-b px-3">
        {railPlugins.map((p) => (
          <button
            key={p.id}
            onClick={() => onChange(p.id)}
            title={p.name}
            className={cn(
              "grid size-8 place-items-center rounded-md transition-colors",
              p.id === activeManifest?.id ? "bg-accent text-primary" : "text-muted-foreground hover:bg-accent/60",
            )}
          >
            <Icon name={p.icon ?? "plugin"} size={17} />
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {sandboxed && activeManifest ? (
          <PluginSlot
            key={`${activeManifest.id}:railPanel`}
            plugin={activeManifest.id}
            slot="railPanel"
            source={sandboxed.source}
            capabilities={capabilities}
          />
        ) : Panel ? (
          <Panel />
        ) : (
          <div className="text-sm text-muted-foreground">No panel for this plugin.</div>
        )}
      </div>
    </aside>
  );
}
