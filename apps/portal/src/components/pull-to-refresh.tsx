import { useCallback, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/lib/icons";
import { cn } from "@/lib/utils";

const THRESHOLD = 70; // px the user must pull past to trigger a refresh
const MAX_PULL = 110; // visual cap on how far the content follows the finger
const RESISTANCE = 0.5; // drag feels heavier than 1:1 finger movement

/**
 * Wraps a vertically scrolling region and adds native-style pull-to-refresh.
 * `onRefresh` runs when the user drags past the threshold from the top; the
 * spinner stays until its promise settles. Touch-only — a no-op with a mouse.
 */
export function PullToRefresh({
  onRefresh,
  children,
  className,
}: {
  onRefresh: () => Promise<unknown> | void;
  children: ReactNode;
  className?: string;
}) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [settling, setSettling] = useState(false);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const el = scroller.current;
      if (!el || refreshing || el.scrollTop > 0) return;
      const t = e.touches[0]!;
      start.current = { x: t.clientX, y: t.clientY };
      setSettling(false);
    },
    [refreshing],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!start.current || refreshing) return;
      const el = scroller.current;
      const t = e.touches[0]!;
      const dy = t.clientY - start.current.y;
      const dx = t.clientX - start.current.x;
      // Bail on upward or mostly-horizontal gestures, or if scroll moved off top.
      if (dy <= 0 || Math.abs(dx) > dy || (el && el.scrollTop > 0)) {
        start.current = null;
        setDistance(0);
        return;
      }
      setDistance(Math.min(MAX_PULL, dy * RESISTANCE));
    },
    [refreshing],
  );

  const onTouchEnd = useCallback(() => {
    if (!start.current) return;
    start.current = null;
    setSettling(true);
    if (distance < THRESHOLD || refreshing) {
      setDistance(0);
      return;
    }
    setRefreshing(true);
    setDistance(THRESHOLD);
    Promise.resolve(onRefresh()).finally(() => {
      setRefreshing(false);
      setDistance(0);
    });
  }, [distance, refreshing, onRefresh]);

  const progress = Math.min(1, distance / THRESHOLD);
  const transition = settling ? "transform 0.2s ease-out" : "none";

  return (
    <div
      ref={scroller}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      className={cn("relative overscroll-y-contain", className)}
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center"
        style={{ transform: `translateY(${distance - 38}px)`, opacity: progress, transition }}
      >
        <span className="grid size-9 place-items-center rounded-full border bg-card shadow-sm">
          <Icon
            name="restore"
            size={18}
            className={cn("text-primary", refreshing && "animate-spin")}
            style={refreshing ? undefined : { transform: `rotate(${-progress * 270}deg)` }}
          />
        </span>
      </div>
      <div style={{ transform: `translateY(${distance}px)`, transition }}>{children}</div>
    </div>
  );
}
