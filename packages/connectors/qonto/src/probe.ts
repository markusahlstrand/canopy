import { connectionProbe, type ConnectionProbe } from '@substrat-run/contracts';
import type { FetchLike } from '@substrat-run/kernel';
import { createQontoClient, QontoError, qontoSecret } from './client.js';

/**
 * Read the organization the key belongs to. Only 401 and 403 are a verdict on the credential; a
 * timeout or a Qonto outage says nothing either way and must not block a connect.
 */
export async function probeQontoSecret(raw: Readonly<Record<string, string>>, options: { fetch: FetchLike; apiBase?: string }): Promise<ConnectionProbe> {
  const parsed = qontoSecret.safeParse(raw);
  if (!parsed.success) return probeOf({ ok: false, refused: true, error: `incomplete credential: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}` });
  try {
    const organization = await createQontoClient({ secret: parsed.data, ...options }).organization();
    return probeOf({
      ok: true,
      accountRef: parsed.data.login,
      accountLabel: (organization.legal_name ?? organization.name ?? organization.slug).slice(0, 200),
      facts: [{ label: 'Bank accounts', value: String(organization.bank_accounts.length) }],
    });
  } catch (e) {
    const refused = e instanceof QontoError && (e.status === 401 || e.status === 403);
    return probeOf({ ok: false, refused, error: refused ? 'Qonto refused this login and secret key.' : (e instanceof Error ? e.message : String(e)).slice(0, 600) });
  }
}

function probeOf(p: Partial<ConnectionProbe> & { ok: boolean }): ConnectionProbe {
  return connectionProbe.parse({ refused: false, accountRef: null, accountLabel: null, facts: [], error: null, ...p });
}
