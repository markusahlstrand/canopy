/**
 * Removing somebody from a space, as an ORDER rather than as a route (#79).
 *
 * The order is the whole safety property, and it was wrong once: grants first, which review
 * caught. So it lives here, apart from the Cloudflare bindings and the Hono context, where a
 * test can drive it — including the failures, which is the half that matters. A property
 * defended only by a comment in a route nothing can call is not defended.
 *
 * The steps are injected for the same reason. The route supplies the real ones (the identity
 * directory, the scope stub, the host); the test supplies ones that count their calls and
 * throw on command.
 */

/** What removal needs done, each idempotent, each replaceable in a test. */
export interface RemovalSteps {
  /**
   * Unbind every subject bound to this principal, and say how many there were.
   *
   * FIRST, and the reason is the one thing no other step can claim: principal resolution goes
   * through the directory on every request, so an unbound subject resolves to nobody even
   * holding a live session cookie. That cuts access to everything they hold — including a grant
   * the drive never recorded, which is possible, because nothing enumerates kernel grants and a
   * grant made at the platform's admin seam has no projection row.
   */
  unbind: () => Promise<number>;
  /**
   * Revoke the folder grants the drive recorded, and forget what we called them. Returns
   * whatever the operation reported, unread by this module.
   */
  forgetGrants: () => Promise<{ revoked: number; forgotten: boolean }>;
  /** Revoke every role this vertical defines, which is space-wide read gone. */
  revokeRoles: () => Promise<number>;
}

export interface Removal {
  unbound: number;
  revoked: number;
  forgotten: boolean;
  roles: number;
}

/**
 * Run the removal.
 *
 * Sequential and un-caught on purpose. A failure stops the rest and reaches the caller, which
 * is right in both directions: stop anywhere and the person has strictly less than before, and
 * the answer never claims more than happened. Every step is idempotent, so the fix for a
 * failure is to call this again.
 *
 * `forgetGrants` runs TWICE, and the second time is not belt-and-braces about the grants — it is
 * about the roster row. `/api/me` records whoever calls it, so a request of theirs already in
 * flight can write that row back after the first pass: its own resolve happened before the
 * unbind, and its write is deferred until after its response. Without the second pass, removal
 * reports success over a list that still names them.
 */
export async function removeMember(steps: RemovalSteps): Promise<Removal> {
  const unbound = await steps.unbind();
  const first = await steps.forgetGrants();
  const roles = await steps.revokeRoles();
  const settled = await steps.forgetGrants();

  return {
    unbound,
    // The first pass is the one that took anything; the second exists to win a race.
    revoked: first.revoked + settled.revoked,
    forgotten: first.forgotten || settled.forgotten,
    roles,
  };
}
