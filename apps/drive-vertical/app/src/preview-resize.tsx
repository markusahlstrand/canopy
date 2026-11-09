import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { cn } from '@canopy/ui';

const WIDTH_KEY = 'canopy.previewWidth';
export const PREVIEW_WIDTH_VAR = '--preview-w';
export const PREVIEW_DEFAULT_WIDTH = 448;
export const PREVIEW_MIN_WIDTH = 320;
/** Kept for the rail and the list. The wrapper's CSS `max-width` says the same, for a window that shrinks later. */
const LIST_ROOM = 560;
const KEY_STEP = 32;

const maxWidth = (viewport: number) => Math.max(PREVIEW_MIN_WIDTH, viewport - LIST_ROOM);
export const clampPreviewWidth = (width: number, viewport = window.innerWidth) =>
  Math.min(Math.max(Math.round(width), PREVIEW_MIN_WIDTH), maxWidth(viewport));

function storedWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY) ?? NaN);
    return Number.isFinite(stored) && stored > 0 ? stored : PREVIEW_DEFAULT_WIDTH;
  } catch { return PREVIEW_DEFAULT_WIDTH; }
}

/** The docked preview's width, remembered across files and sessions. */
export function usePreviewWidth(): [number, (width: number) => void] {
  const [width, setWidth] = useState(storedWidth);
  const save = useCallback((next: number) => {
    setWidth(next);
    try { localStorage.setItem(WIDTH_KEY, String(next)); } catch { /* storage unavailable: keep it for this session */ }
  }, []);
  return [width, save];
}

/**
 * The docked preview's left border, as a drag handle. It sits inside the element it resizes.
 *
 * A drag writes the width straight onto that element and tells the host once, on release: the host
 * is the whole drive screen, which should not re-render for every pixel of mouse movement.
 */
export function PreviewResizeHandle({ width, onChange }: { width: number; onChange: (width: number) => void }) {
  const handle = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; width: number; last: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const current = clampPreviewWidth(width);

  const apply = (next: number) => handle.current?.parentElement?.style.setProperty(PREVIEW_WIDTH_VAR, `${next}px`);
  const begin = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault(); // No text selection under the drag.
    start.current = { x: event.clientX, width: current, last: current };
    setDragging(true);
  };

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      if (!start.current) return;
      // The border is the pane's left edge: moving it left makes the pane wider.
      start.current.last = clampPreviewWidth(start.current.width + start.current.x - event.clientX);
      apply(start.current.last);
    };
    const finish = (commit: boolean) => {
      const drag = start.current;
      start.current = null;
      setDragging(false);
      if (!drag) return;
      if (commit) onChange(drag.last);
      else apply(drag.width);
    };
    const up = () => finish(true), cancel = () => finish(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [dragging, onChange]);

  const key = (event: KeyboardEvent) => {
    const next = event.key === 'ArrowLeft' ? current + KEY_STEP : event.key === 'ArrowRight' ? current - KEY_STEP
      : event.key === 'Home' ? PREVIEW_DEFAULT_WIDTH : null;
    if (next === null) return;
    event.preventDefault();
    onChange(clampPreviewWidth(next));
  };

  return <>
    <div
      ref={handle}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize preview"
      aria-valuenow={current}
      aria-valuemin={PREVIEW_MIN_WIDTH}
      aria-valuemax={maxWidth(window.innerWidth)}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      className="group absolute inset-y-0 -left-1.5 z-10 hidden w-3 cursor-col-resize touch-none outline-none md:block"
      onPointerDown={begin}
      onDoubleClick={() => onChange(clampPreviewWidth(PREVIEW_DEFAULT_WIDTH))}
      onKeyDown={key}
    >
      <span className={cn('absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors group-hover:bg-primary/50 group-focus-visible:bg-primary', dragging && 'bg-primary')} />
    </div>
    {/* A PDF or plugin iframe under the pointer would otherwise take the drag's mouse events. */}
    {dragging ? <div aria-hidden className="fixed inset-0 z-50 cursor-col-resize select-none" /> : null}
  </>;
}
