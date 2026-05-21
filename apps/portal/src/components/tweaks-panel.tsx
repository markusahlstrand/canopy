import { Settings2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { ACCENT_HSL, type Tweaks } from "@/lib/tweaks";

interface TweaksPanelProps {
  t: Tweaks;
  setTweak: <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-md border p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-[5px] px-2 py-1 text-[12px] transition-colors",
            value === o.value ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function TweaksPanel({ t, setTweak }: TweaksPanelProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="fixed bottom-4 right-4 z-50 grid size-10 place-items-center rounded-full border bg-card text-muted-foreground shadow-lg hover:text-foreground"
          title="Tweaks"
        >
          <Settings2 size={18} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-72">
        <div className="flex flex-col gap-3.5">
          <div className="text-[13px] font-semibold">Tweaks</div>

          <Row label="Mode">
            <Segmented
              value={t.theme}
              onChange={(v) => setTweak("theme", v)}
              options={[
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
          </Row>

          <Row label="Accent">
            <div className="flex gap-1.5">
              {Object.entries(ACCENT_HSL).map(([key, hsl]) => (
                <button
                  key={key}
                  onClick={() => setTweak("accent", key)}
                  title={key}
                  className="size-5 rounded-full ring-offset-2 ring-offset-background transition-shadow"
                  style={{
                    background: `hsl(${hsl})`,
                    boxShadow: t.accent === key ? "0 0 0 2px hsl(var(--foreground))" : "none",
                  }}
                />
              ))}
            </div>
          </Row>

          <Row label="Radius">
            <Segmented
              value={t.radius}
              onChange={(v) => setTweak("radius", v)}
              options={[
                { value: "square", label: "▢" },
                { value: "default", label: "▣" },
                { value: "round", label: "◯" },
              ]}
            />
          </Row>

          <Row label="Density">
            <Segmented
              value={t.density}
              onChange={(v) => setTweak("density", v)}
              options={[
                { value: "compact", label: "S" },
                { value: "default", label: "M" },
                { value: "comfy", label: "L" },
              ]}
            />
          </Row>

          <Row label="Font">
            <Segmented
              value={t.font}
              onChange={(v) => setTweak("font", v)}
              options={[
                { value: "geist", label: "Geist" },
                { value: "inter", label: "Inter" },
                { value: "system", label: "System" },
              ]}
            />
          </Row>

          <div className="h-px bg-border" />

          <Row label="Collapse sidebar">
            <input
              type="checkbox"
              checked={t.sidebarCollapsed}
              onChange={(e) => setTweak("sidebarCollapsed", e.target.checked)}
              className="size-4 accent-primary"
            />
          </Row>
          <Row label="Show plugin rail">
            <input
              type="checkbox"
              checked={t.showRail}
              onChange={(e) => setTweak("showRail", e.target.checked)}
              className="size-4 accent-primary"
            />
          </Row>
        </div>
      </PopoverContent>
    </Popover>
  );
}
