/**
 * Only the newest ask may write to the screen.
 *
 * Debouncing cancels pending TIMERS; it does nothing about a request already in flight.
 * Type `lea`, pause, type `se`, and two requests exist — if the first answers second,
 * the screen shows hits for `lea` under a box reading `lease`. The same race moves a
 * folder listing: click into a folder, click back, and the deeper listing can land last.
 *
 * So every read takes a ticket and only writes if it is still the current one.
 *
 * `invalidate` is the other half, and it is not decoration: taking a ticket only when a
 * read STARTS leaves a window. The search box is debounced by 200ms, so between a
 * keystroke and the request it triggers, the previous term's request still holds the
 * current ticket — and if it answers inside that window it writes hits for a term the
 * box no longer holds, below the minimum length, having cleared `busy` on the way out.
 * So the context changing invalidates immediately, before anything is scheduled.
 */
export function latestOnly() {
  let issued = 0;
  return {
    /** Claim the screen for this read, invalidating every earlier one. */
    take: () => ++issued,
    /**
     * The screen's context changed — a term, a folder, a view. Nothing already in
     * flight may write, and no ticket is claimed: the next read takes its own.
     */
    invalidate: () => {
      issued += 1;
    },
    /** May this read still write? */
    current: (ticket: number) => ticket === issued,
  };
}
