import { useOnline } from "@/hooks/use-online";
import { Icon } from "@/lib/icons";

/** Thin banner shown while the browser is offline (the SW serves cached content). */
export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className="flex shrink-0 items-center justify-center gap-1.5 border-b bg-warning/15 px-4 py-1.5 text-center text-[13px] text-foreground">
      <Icon name="cloud-off" size={14} className="text-warning" />
      You're offline — showing cached content.
    </div>
  );
}
