import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Icon } from "@/lib/icons";
import {
  CACHE_PRESETS,
  cacheUsage,
  clearSpaceContent,
  humanSize,
  readCacheLimit,
  setCacheLimit,
} from "@/lib/api";

/**
 * A space's offline cache budget — a **local, per-device** choice (the cache lives in
 * this browser): how many bytes of opened-file content to keep for this space, so the
 * images and documents you've viewed load instantly and stay available offline. Picked
 * from friendly presets (Off · 250 MB · 1 GB · 5 GB · Unlimited). Lowering the limit (or
 * choosing Off) immediately evicts the space's oldest cached files down to the new budget.
 */
export function CacheBudgetControl({ space }: { space: string }) {
  // `limit` is null until loaded; `usage` is the bytes currently cached for this space.
  const [limit, setLimit] = useState<number | null>(null);
  const [usage, setUsage] = useState(0);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [l, u] = await Promise.all([readCacheLimit(space), cacheUsage(space)]);
    setLimit(l);
    setUsage(u);
  }, [space]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function change(bytes: number) {
    setBusy(true);
    setLimit(bytes); // optimistic — the Select reflects the choice immediately
    try {
      await setCacheLimit(space, bytes);
    } finally {
      await refresh(); // pick up any eviction the new limit triggered
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    try {
      await clearSpaceContent(space);
    } finally {
      await refresh();
      setBusy(false);
    }
  }

  const off = limit === 0;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <Select
          value={limit == null ? undefined : String(limit)}
          onValueChange={(v) => void change(Number(v))}
          disabled={busy || limit == null}
        >
          <SelectTrigger className="w-[140px]" size="sm">
            <SelectValue placeholder="…" />
          </SelectTrigger>
          <SelectContent>
            {CACHE_PRESETS.map((p) => (
              <SelectItem key={p.bytes} value={String(p.bytes)}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-[12.5px] text-muted-foreground">
          {off ? "Caching off" : `${humanSize(usage)} cached`}
        </span>
      </div>
      <p className="text-[12px] text-muted-foreground">
        Files you open in this space are kept on this device so they load instantly and work
        offline. When the limit is reached, the files you opened longest ago are removed first.
      </p>
      {usage > 0 && (
        <Button
          variant="outline"
          size="sm"
          className="self-start gap-1.5"
          disabled={busy}
          onClick={() => void clear()}
        >
          <Icon name="trash" size={14} /> Clear cached files
        </Button>
      )}
    </div>
  );
}
