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

/**
 * Every subject bound to one principal, unbound — or nothing at all.
 *
 * Here rather than in the route because of the refusal below, which is a correctness property
 * and belongs where a test can reach it.
 *
 * The directory maps subject → principal and offers no reverse lookup, so finding whose bindings
 * to remove means resolving the scope's subjects and comparing. That scan is bounded, and a FULL
 * scan is the problem: it cannot prove it saw every subject, so it cannot prove it found every
 * binding this principal has. Unbinding the matches it did find and carrying on would report a
 * removal while another binding stayed live — the person still reaches the space, and the answer
 * says they do not.
 *
 * So a saturated scan refuses, and refuses BEFORE anything is revoked. That is what makes the
 * order worth having: this is step one, so a refusal here leaves the person exactly as they were
 * rather than half removed. The test asserts that, since it is the part reading cannot check.
 *
 * Not gated on how many were unbound: a nonzero count proves a binding was found, never that all
 * of them were.
 */
export async function unbindEveryBinding(deps: {
  /** The scope's bound subjects, at most `limit` of them. */
  list: (limit: number) => Promise<string[]>;
  /** Which principal a subject resolves to, or null. */
  principalOf: (sub: string) => Promise<string | null>;
  /** Unbind one subject; true when there was a binding to remove. */
  unbind: (sub: string) => Promise<boolean>;
  target: string;
  limit: number;
}): Promise<number> {
  const subjects = await deps.list(deps.limit);
  if (subjects.length >= deps.limit) {
    throw new ScanSaturated(deps.limit);
  }

  let unbound = 0;
  for (const sub of subjects) {
    if ((await deps.principalOf(sub)) !== deps.target) continue;
    if (await deps.unbind(sub)) unbound += 1;
  }
  return unbound;
}

/**
 * The scan filled up, so removal did not start.
 *
 * Its own type because the route turns it into a status a caller can act on, and because the fix
 * is not a bigger limit: the directory needs to answer "which subjects are bound to this
 * principal" directly, or take the unbind by principal. Raised upstream as
 * substrat-run/substrat#1939.
 */
export class ScanSaturated extends Error {
  constructor(readonly limit: number) {
    super(
      `cannot remove: this space has at least ${limit} bound logins, more than the directory `
        + 'can be scanned for one principal — nothing was changed',
    );
    this.name = 'ScanSaturated';
  }
}
