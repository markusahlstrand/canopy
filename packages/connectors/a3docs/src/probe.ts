import { connectionProbe, type ConnectionCredential, type ConnectionProbe } from '@substrat-run/contracts';
import type { ScopeHost } from '@substrat-run/kernel';
import { A3docError, canUploadAs, type A3docClient } from './client.js';
import { a3docSecret, clientFor, openA3docConnection, openSecret, type A3docOptions, type ConnectionRef } from './connection.js';

/**
 * No standing grants. Everything this connector lands goes through the vertical's own operation,
 * whose permission the binding names and `bindA3docScope` checks on the scope.
 */
export const A3DOC_CONNECTION_GRANTS: readonly string[] = [];

/** Check a credential that is not stored yet: the connect-time gate. */
export async function probeA3docSecret(raw: Record<string, string>, options: A3docOptions): Promise<ConnectionProbe> {
  const parsed = a3docSecret.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    return probeOf({ ok: false, refused: true, error: `incomplete credential: ${fields}` });
  }
  return probeWith(clientFor(options.fetch, parsed.data, options), parsed.data.companyCode);
}

/** Check the live connection's credential: **Test connection**. */
export async function probeA3docConnection(host: ScopeHost, connection: ConnectionRef, options: A3docOptions): Promise<ConnectionProbe> {
  const conn = await openA3docConnection(host.admin, options, connection);
  return probeWith(conn.client, conn.secret.companyCode);
}

/**
 * Sign in, then read who that is. A refusal from a3doc (an `errorCode` on `signIn`) is a definite
 * answer about the credential; anything else (a timeout, a page that is not a3doc's JSON) is the
 * probe not being able to tell, which must never block a connect.
 */
async function probeWith(client: A3docClient, companyCode: string): Promise<ConnectionProbe> {
  try {
    await client.signIn();
  } catch (e) {
    // An A3docError is a3doc answering: the address provider knows no such company, or signIn
    // refused the user and password. Anything else is the network, and says nothing either way.
    return probeOf({ ok: false, refused: e instanceof A3docError, error: messageOf(e) });
  }
  try {
    const me = await client.userInfo();
    const upload = canUploadAs(me.role);
    return probeOf({
      ok: true,
      accountRef: companyCode,
      accountLabel: [me.name, me.email && `(${me.email})`].filter(Boolean).join(' ').slice(0, 200) || null,
      facts: [
        { label: 'Company code', value: companyCode },
        { label: 'Can upload', value: upload ? 'yes' : 'no: this a3doc user may only read' },
      ],
    });
  } catch (e) {
    return probeOf({ ok: false, refused: false, error: messageOf(e) });
  }
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 600);

function probeOf(p: Partial<ConnectionProbe> & { ok: boolean }): ConnectionProbe {
  return connectionProbe.parse({ refused: false, accountRef: null, accountLabel: null, facts: [], error: null, ...p });
}

/** The stored credential, reduced: identifiers whole, the password masked. */
export async function a3docCredentialSummary(host: ScopeHost, connection: ConnectionRef): Promise<ConnectionCredential> {
  const { secret } = await openSecret(host.admin, connection);
  return {
    fields: [
      { key: 'companyCode', label: 'Company code', value: secret.companyCode, masked: false },
      { key: 'user', label: 'User', value: secret.user, masked: false },
      { key: 'password', label: 'Password', value: '••••••••', masked: true },
      ...(secret.customerId ? [{ key: 'customerId', label: 'Uploads filed under', value: secret.customerId, masked: false }] : []),
    ],
  };
}
