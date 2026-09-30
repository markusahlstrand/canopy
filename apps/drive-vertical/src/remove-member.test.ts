/**
 * The order in which somebody is removed, and what a failure leaves behind (#79).
 *
 * Every claim the route's comment makes, as a test — because the first version of that comment
 * described the wrong order confidently, and review caught it rather than the suite.
 */
import { describe, expect, it } from 'vitest';
import { removeMember, type RemovalSteps } from './remove-member.js';

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
