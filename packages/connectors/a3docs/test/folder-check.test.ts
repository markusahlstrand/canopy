import { expect, it } from 'vitest';
import { attachmentRecord, connectionId, scopeId, tenantId, type FileSourceChange } from '@substrat-run/contracts';
import { ulid, type ScopedConnectionContext } from '@substrat-run/kernel';
import { a3docConnectorDefinition, a3docFolderChecks, A3DOC_VERTICAL_PROVIDER } from '../src/vertical.js';
import { SESSION_KEY } from '../src/files.js';
import { FakeA3doc, ADDRESS, COMPANY, USER, PASSWORD, CUSTOMER } from './fake-a3doc.js';

/** The platform's side of a call, as `vertical.test.ts` builds it, plus the drive's view by item id. */
function world() {
  const a3 = new FakeA3doc();
  const def = a3docConnectorDefinition({ addressProvider: ADDRESS, journalOperation: 'drive/source-write-journal' });
  const check = a3docFolderChecks({ addressProvider: ADDRESS });
  const state = new Map<string, unknown>(), journal = new Map<string, unknown>();
  const changes: FileSourceChange[] = [];
  const drive = new Map<string, string>();
  const t = tenantId.parse(ulid()), s = scopeId.parse(ulid()), id = connectionId.parse(ulid());
  const record = attachmentRecord.parse({ id: 'upload', entity: { entityType: 'file', entityId: 'file' }, filename: 'Upload.pdf', contentType: 'application/pdf', size: 5, sha256: 'a'.repeat(64), visibility: 'internal', createdBy: 'author', createdAt: '2026-10-27T09:00:00.000Z' });
  const ctx: ScopedConnectionContext = {
    connection: { id, tenantId: t, provider: A3DOC_VERTICAL_PROVIDER, vertical: 'drive', externalAccountRef: COMPANY, expiresAt: null },
    secret: { companyCode: COMPANY, user: USER, password: PASSWORD, customerId: CUSTOMER }, fetch: a3.fetch,
    state: {
      get: async key => structuredClone(state.get(key)),
      put: async (key, value) => { if (value === null) state.delete(key); else state.set(key, structuredClone(value)); },
      list: async (prefix = '') => [...state].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })),
    },
    scope: { tenantId: t, scopeId: s, operation: 'drive/land-source-change', options: {} },
    land: async <O>(input: unknown) => {
      const c = input as FileSourceChange;
      changes.push(c);
      if (c.change === 'upsert' && c.kind === 'file') drive.set(c.itemId, c.path);
      if (c.change === 'delete') drive.delete(c.itemId);
      return { entity: record.entity } as O;
    },
    invoke: async <O>(operation: string, input?: unknown) => {
      if (operation === 'drive/source-write-journal') {
        const { key, value } = input as { key: string; value?: unknown };
        if (value !== undefined) journal.set(key, structuredClone(value));
        return { value: structuredClone(journal.get(key)) } as O;
      }
      return ctx.land<O>(input);
    },
    attachments: {
      upload: async (input) => ({ ...record, id: ulid(), entity: input.entity, filename: input.filename }),
      open: async () => ({ record, contentType: record.contentType, body: new TextEncoder().encode('bytes') }),
    },
  };
  const bind = async (folder = '') => { ctx.scope.options = await def.bind!(ctx, { folder }); };
  /** A call as the platform runs it: state writes are kept only when it succeeds. */
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    const before = structuredClone(state);
    try { return await fn(); } catch (e) { state.clear(); for (const [k, v] of before) state.set(k, v); throw e; }
  };
  const logins = () => a3.calls.filter(c => c.method === 'LoginMfaBegin').length;
  const paths = () => [...drive.values()].sort();
  return { a3, def, check: (p: string[]) => call(() => check(ctx, p)), sweep: () => call(() => def.sweep!(ctx)), ctx, state, changes, bind, logins, paths };
}

it('lands what was added to, changed in and removed from one folder, and nothing outside it', async () => {
  const w = world();
  const a = w.a3.add([21], 'Invoice A', 'first');
  const b = w.a3.add([21], 'Invoice B', 'second');
  await w.bind('Facturas');
  await w.sweep();
  expect(w.paths()).toEqual(['Recibidas/Invoice A.pdf', 'Recibidas/Invoice B.pdf']);
  w.changes.length = 0;

  w.a3.add([21], 'Invoice C', 'third');
  w.a3.edit(a, { bytes: new TextEncoder().encode('first, corrected') });
  w.a3.remove(b);
  // Filed in the bound folder itself, not in the one checked: the next pass finds it, not this check.
  w.a3.add([20], 'Elsewhere', 'not here');

  const checks = await w.check(['Recibidas']);
  expect(checks).toEqual([{ path: 'Recibidas', changes: 3, complete: true }]);
  expect(w.paths()).toEqual(['Recibidas/Invoice A.pdf', 'Recibidas/Invoice C.pdf']);
  expect(w.changes.filter(c => c.change === 'content').map(c => c.path).sort()).toEqual(['Recibidas/Invoice A.pdf', 'Recibidas/Invoice C.pdf']);
  // The removal landed only after a3doc answered about that document itself.
  expect(w.changes.find(c => c.change === 'delete')).toMatchObject({ path: 'Recibidas/Invoice B.pdf', reason: 'deleted' });
  expect(w.a3.calls.some(c => c.method === 'Download' && c.body.documentId === b.Id)).toBe(true);

  // Checked again with nothing new in a3doc: nothing lands twice.
  const before = w.changes.length;
  expect(await w.check(['Recibidas'])).toEqual([{ path: 'Recibidas', changes: 0, complete: true }]);
  expect(w.changes).toHaveLength(before);
});

it('lands a document moved to another folder as moved out, and its new placement', async () => {
  const w = world();
  const doc = w.a3.add([21], 'Receipt', 'bytes');
  await w.bind('');
  await w.sweep();
  w.a3.edit(doc, { ContainersId: [11] });
  await w.check(['Fiscal/Modelo 303']);
  expect(w.paths()).toEqual(['Fiscal/Modelo 303/Receipt.pdf']);
  expect(w.changes.find(c => c.change === 'delete')).toMatchObject({ path: 'Facturas/Recibidas/Receipt.pdf', reason: 'moved-out' });
});

it('signs in once for every folder of a call, and reuses the session on the next call', async () => {
  const w = world();
  w.a3.add([21], 'Invoice', 'bytes');
  await w.bind('Facturas');
  const afterBind = w.logins();
  await w.sweep();
  expect(w.logins()).toBe(afterBind + 1);
  expect(w.state.get(SESSION_KEY)).toMatchObject({ token: expect.any(String) });

  await w.check(['Recibidas', '']);
  await w.check(['Recibidas']);
  expect(w.logins()).toBe(afterBind + 1);

  // a3doc expires the token: the call signs in once more, carries on, and keeps the new session.
  (w.a3 as unknown as { token: string }).token = 'expired-elsewhere';
  w.a3.add([21], 'Late invoice', 'bytes');
  expect(await w.check(['Recibidas'])).toEqual([{ path: 'Recibidas', changes: 1, complete: true }]);
  expect(w.logins()).toBe(afterBind + 2);
  await w.check(['Recibidas']);
  expect(w.logins()).toBe(afterBind + 2);
});

it('keeps a call under the outbound ceiling, and finishes a big folder on the next check', async () => {
  const w = world();
  await w.bind('Facturas');
  await w.sweep();
  for (let i = 0; i < 40; i++) w.a3.add([21], `Invoice ${i}`, `bytes ${i}`);
  const before = w.a3.calls.length;
  const [first] = await w.check(['Recibidas']);
  expect(w.a3.calls.length - before).toBeLessThan(100);
  expect(first).toMatchObject({ complete: false });
  expect(w.paths()).toHaveLength(15);
  await w.check(['Recibidas']);
  const [last] = await w.check(['Recibidas']);
  expect(last).toMatchObject({ complete: true });
  expect(w.paths()).toHaveLength(40);
});

it('says a folder a3doc no longer has is missing, and fails the call when a3doc wants MFA', async () => {
  const w = world();
  await w.bind('Facturas');
  expect(await w.check(['Gone'])).toEqual([{ path: 'Gone', changes: 0, complete: true, missing: true }]);
  w.state.delete(SESSION_KEY);
  w.a3.mfa = 2;
  await expect(w.check(['Recibidas'])).rejects.toThrow('MFA');
});
