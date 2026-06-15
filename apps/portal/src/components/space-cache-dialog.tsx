import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CacheBudgetControl } from "@/components/cache-budget";

/**
 * "Offline files" for a single space — a lightweight dialog hosting that space's local
 * cache budget. Works for any space token (personal drive "", a group-space id, or a
 * "connector:<plugin>" connected space), since the budget is purely a client-side,
 * per-device preference (no server calls). Reached from each space's context menu.
 */
export function SpaceCacheDialog({
  space,
  spaceName,
  open,
  onOpenChange,
}: {
  /** UI space token: "" = personal drive, "connector:<plugin>" = connected, else a group id. */
  space: string;
  spaceName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Offline files</DialogTitle>
          <DialogDescription>
            Choose how much of “{spaceName}” to keep on this device for instant, offline access.
          </DialogDescription>
        </DialogHeader>
        <CacheBudgetControl space={space} />
      </DialogContent>
    </Dialog>
  );
}
