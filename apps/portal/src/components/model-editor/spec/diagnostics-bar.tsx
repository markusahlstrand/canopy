import { Icon } from "@canopy/ui";
import { cn } from "@canopy/ui";
import type { Diagnostic, SelectionRef } from "./graph-types";

/**
 * The cross-layer diagnostics strip. Each dangling reference is listed here and, when
 * it points at a graph item, is clickable to select + reveal the broken edge in its
 * tab. This is the unified-editor payoff: failures that span layers, in one place.
 */
export function DiagnosticsBar({
  diagnostics,
  open,
  onToggle,
  onNavigate,
}: {
  diagnostics: Diagnostic[];
  open: boolean;
  onToggle: () => void;
  onNavigate: (ref: SelectionRef) => void;
}) {
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;
  const clean = diagnostics.length === 0;

  return (
    <div className="shrink-0 border-t bg-background">
      <button onClick={onToggle} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-accent/40">
        <Icon name={clean ? "circle-check" : "alert-triangle"} size={14} className={clean ? "text-emerald-500" : errors ? "text-destructive" : "text-amber-500"} />
        {clean ? (
          <span className="text-muted-foreground">No problems — all cross-layer references resolve.</span>
        ) : (
          <span className="font-medium">
            {errors > 0 && <span className="text-destructive">{errors} error{errors > 1 ? "s" : ""}</span>}
            {errors > 0 && warnings > 0 && <span className="text-muted-foreground"> · </span>}
            {warnings > 0 && <span className="text-amber-600">{warnings} warning{warnings > 1 ? "s" : ""}</span>}
          </span>
        )}
        {!clean && <Icon name={open ? "chevron-down" : "chevron-right"} size={14} className="ml-auto text-muted-foreground" />}
      </button>
      {open && !clean && (
        <ul className="max-h-44 overflow-y-auto border-t">
          {diagnostics.map((d, i) => (
            <li key={i}>
              <button
                onClick={() => d.target && onNavigate(d.target)}
                disabled={!d.target}
                className={cn("flex w-full items-start gap-2 px-3 py-1.5 text-left text-[12px]", d.target ? "hover:bg-accent/40" : "cursor-default")}
              >
                <Icon name={d.severity === "error" ? "alert-triangle" : "alert-triangle"} size={13} className={cn("mt-0.5 shrink-0", d.severity === "error" ? "text-destructive" : "text-amber-500")} />
                <span className="flex-1">{d.message}</span>
                {d.file && <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{d.file}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
