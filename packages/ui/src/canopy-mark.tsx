/** The Canopy brand glyph (from the design handoff) — a canopy dome with a trunk. */
export function CanopyMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3c-3 0-5 2-5 5 0 1 .3 2 .8 2.8C5 11 3 13 3 16h18c0-3-2-5-4.8-5.2.5-.8.8-1.8.8-2.8 0-3-2-5-5-5z" />
      <path d="M12 16v5" />
    </svg>
  );
}
