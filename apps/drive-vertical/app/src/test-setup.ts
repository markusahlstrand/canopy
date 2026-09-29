/**
 * What jsdom does not implement and the moved components need.
 *
 * `cmdk` (the command palette) observes its list's size to keep the selected item in
 * view, and jsdom has no `ResizeObserver` — so rendering the palette throws before any
 * assertion runs. A no-op is the right stub: the tests here assert what the palette
 * SHOWS, never how it scrolls.
 */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!('ResizeObserver' in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver;
}

// Radix's dialogs measure the scrollbar the same way; jsdom reports 0 for both, which is
// consistent and fine — it just has to exist.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}
