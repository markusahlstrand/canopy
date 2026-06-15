import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { EXPORT_TARGETS, type ExportFormat } from "./export";
import type { DomainModel } from "./types";

export function ExportPanel({ model }: { model: DomainModel }) {
  const [format, setFormat] = useState<ExportFormat>("json");
  const [copied, setCopied] = useState(false);

  const target = EXPORT_TARGETS.find((t) => t.id === format)!;
  const code = useMemo(() => {
    try {
      return target.render(model);
    } catch (e) {
      return `// Export failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }, [target, model]);

  function copy() {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function download() {
    const blob = new Blob([code], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = target.filename(model.name);
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap gap-1 border-b p-2">
        {EXPORT_TARGETS.map((t) => (
          <button
            key={t.id}
            onClick={() => setFormat(t.id)}
            className={cn(
              "rounded-md px-2.5 py-1 text-[12px] font-medium transition",
              format === t.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2 px-3 py-2">
        <span className="font-mono text-[11px] text-muted-foreground">{target.filename(model.name)}</span>
        <div className="ml-auto flex gap-1.5">
          <Button variant="outline" size="sm" className="h-7 gap-1" onClick={copy}>
            <Icon name={copied ? "circle-check" : "file-text"} size={13} /> {copied ? "Copied" : "Copy"}
          </Button>
          <Button variant="outline" size="sm" className="h-7 gap-1" onClick={download}>
            <Icon name="download" size={13} /> Save
          </Button>
        </div>
      </div>

      <pre className="flex-1 overflow-auto bg-muted/30 px-3 py-2 font-mono text-[12px] leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}
