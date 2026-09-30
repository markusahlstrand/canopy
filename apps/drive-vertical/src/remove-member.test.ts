/**
 * The order in which somebody is removed, and what a failure leaves behind (#79).
 *
 * Every claim the route's comment makes, as a test — because the first version of that comment
 * described the wrong order confidently, and review caught it rather than the suite.
 */
import { describe, expect, it } from 'vitest';
import { ScanSaturated, removeMember, unbindEveryBinding, type RemovalSteps } from './remove-member.js';

/** Steps that record the order they were called in, and can be told to fail. */
function recorder(fail?: { at: keyof RemovalSteps; after?: number }) {
  const calls: string[] = [];
  let forgets = 0;
  const maybeThrow = (step: keyof RemovalSteps, count: number) => {
    if (fail?.at === step && (fail.after ?? 0) < count) throw new Error(`${step} failed`);
  };
  const steps: RemovalSteps = {
    unbind: async () => {
      calls.push('unbind');
      maybeThrow('unbind', 1);
      return 1;
    },
    forgetGrants: async () => {
      forgets += 1;
      calls.push('forgetGrants');
      maybeThrow('forgetGrants', forgets);
      // Only the first pass finds anything; the second is the race-closing one.
      return forgets === 1 ? { revoked: 2, forgotten: true } : { revoked: 0, forgotten: false };
    },
    revokeRoles: async () => {
      calls.push('revokeRoles');
      maybeThrow('revokeRoles', 1);
      return 2;
    },
  };
  return { steps, calls };
}

describe('the order somebody is removed in', () => {
  it('unbinds before it revokes anything', async () => {
    const { steps, calls } = recorder();
    const out = await removeMember(steps);

    // The binding first, because it is the only step that reaches authority this drive cannot
    // see: nothing enumerates kernel grants, so a grant made at the admin seam has no
    // projection row and `forgetGrants` skips it. An unbound subject resolves to nobody.
    expect(calls).toEqual(['unbind', 'forgetGrants', 'revokeRoles', 'forgetGrants']);
    expect(out).toEqual({ unbound: 1, revoked: 2, forgotten: true, roles: 2 });
  });

  it('settles the roster AFTER the roles, to win a race with `/api/me`', async () => {
    const { steps, calls } = recorder();
    await removeMember(steps);

    // `/api/me` records whoever calls it, so a request of theirs already in flight can write the
    // roster row back after the first pass — its resolve happened before the unbind and its
    // write is deferred past its response. The last call is what makes the list true.
    expect(calls[calls.length - 1]).toBe('forgetGrants');
    expect(calls.filter((c) => c === 'forgetGrants')).toHaveLength(2);
  });

  it('leaves the rest untried when the unbind fails, and says so', async () => {
    const { steps, calls } = recorder({ at: 'unbind' });

    await expect(removeMember(steps)).rejects.toThrow('unbind failed');
    // Nothing else ran: they are exactly as they were, which is the honest outcome when the one
    // step that cuts access could not be taken. The alternative — revoking grants anyway — is a
    // half-removal reported as a failure.
    expect(calls).toEqual(['unbind']);
  });

  it('keeps the unbinding when a later step fails', async () => {
    const { steps, calls } = recorder({ at: 'revokeRoles' });

    await expect(removeMember(steps)).rejects.toThrow('revokeRoles failed');
    // They are unbound and their recorded grants are gone: strictly less than before, and
    // unable to act at all. A retry finishes the roles.
    expect(calls).toEqual(['unbind', 'forgetGrants', 'revokeRoles']);
  });

  it('reports what happened rather than what was intended', async () => {
    // A removal that found nothing to revoke — somebody already removed, or never shared with.
    const steps: RemovalSteps = {
      unbind: async () => 0,
      forgetGrants: async () => ({ revoked: 0, forgotten: false }),
      revokeRoles: async () => 2,
    };
    expect(await removeMember(steps)).toEqual({
      unbound: 0,
      revoked: 0,
      forgotten: false,
      roles: 2,
    });
  });
});

describe('finding every binding, or refusing to try', () => {
  /** A directory of `count` subjects, two of which belong to the target. */
  function directory(count: number) {
    const subjects = Array.from({ length: count }, (_, i) => `sub-${i}`);
    const mine = new Set(['sub-1', 'sub-2']);
    const unbound: string[] = [];
    return {
      unbound,
      deps: {
        list: async (limit: number) => subjects.slice(0, limit),
        principalOf: async (sub: string) => (mine.has(sub) ? 'target' : 'somebody-else'),
        unbind: async (sub: string) => {
          unbound.push(sub);
          return true;
        },
        target: 'target',
        limit: 10,
      },
    };
  }

  it('unbinds every binding the principal has, and nobody else’s', async () => {
    const { deps, unbound } = directory(5);
    expect(await unbindEveryBinding(deps)).toBe(2);
    expect(unbound).toEqual(['sub-1', 'sub-2']);
  });

  it('refuses a SATURATED scan rather than unbinding what it happened to see', async () => {
    // Exactly `limit` subjects come back, so the scan cannot prove it saw them all — and
    // therefore cannot prove it found every binding this principal has. Unbinding the matches it
    // did find and carrying on would report a removal with another binding still live.
    const { deps, unbound } = directory(10);
    await expect(unbindEveryBinding(deps)).rejects.toBeInstanceOf(ScanSaturated);
    // NOTHING was unbound: the refusal comes before any change, which is only safe because this
    // is the first step of the removal.
    expect(unbound).toEqual([]);
  });

  it('does not decide on how many it unbound', async () => {
    // A nonzero count proves a binding was found, never that all of them were — so the guard
    // cannot be "did we unbind at least one". A full scan refuses even though two matches were
    // sitting in it.
    const { deps } = directory(10);
    await expect(unbindEveryBinding(deps)).rejects.toThrow(/at least 10 bound logins/);
  });
});
