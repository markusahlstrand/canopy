import { expect, it } from 'vitest';
import { defineConnectors, runConnectorCall } from '@substrat-run/vertical-host/connectors';
import { attachmentRecord, connectionId, domainEvent, scopeId, tenantId, type FileSourceChange } from '@substrat-run/contracts';
import { ulid, type ScopedConnectionContext } from '@substrat-run/kernel';
import { a3docConnectorDefinition, A3DOC_VERTICAL_PROVIDER } from '../src/vertical.js';
import { FakeA3doc, ADDRESS, COMPANY, USER, PASSWORD, CUSTOMER } from './fake-a3doc.js';

function world() {
  const a3 = new FakeA3doc();
  const def = a3docConnectorDefinition({ addressProvider: ADDRESS, journalOperation: 'drive/source-write-journal' });
  const state = new Map<string, unknown>(), journal = new Map<string, unknown>();
  const changes: FileSourceChange[] = [];
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
    land: async <O>(input: unknown) => { changes.push(input as FileSourceChange); return { entity: record.entity } as O; },
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
  return { a3, def, ctx, state, changes, bind, record };
}

it('declares a vertical-owned provider and binds/sweeps inside its selected folder', async () => {
  const w = world();
  w.a3.add([21], 'Invoice', 'inside'); w.a3.add([11], 'Tax', 'outside');
  expect(defineConnectors({ [A3DOC_VERTICAL_PROVIDER]: w.def }).declarations()[0]).toMatchObject({ provider: 'canopy.a3doc', sweeps: true, binds: true, dispatches: true });
  expect(await w.def.probe!(w.ctx)).toMatchObject({ ok: true });
  await w.bind('Facturas');
  expect(w.ctx.scope.options.containerId).toBe(20);
  await w.def.sweep!(w.ctx);
  expect(w.changes.filter(c => c.kind === 'file' && c.change === 'upsert').map(c => c.path)).toEqual(['Recibidas/Invoice.pdf']);
  const before = w.changes.length;
  await w.def.sweep!(w.ctx);
  expect(w.changes).toHaveLength(before);
});

it('persists upload attempts outside transactional call-state and adopts a lost upload answer', async () => {
  const w = world(); await w.bind('Facturas/Recibidas');
  const event = domainEvent.parse({ id: ulid(), type: 'a3doc.files-requested', schemaVersion: 1, occurredAt: '2026-10-27T09:00:00.000Z', tenantId: w.ctx.scope.tenantId, scopeId: w.ctx.scope.scopeId, actor: ulid(), entity: w.record.entity, piiClass: 'none', payload: { conflict: 'rename', files: [{ attachmentId: w.record.id, name: 'Upload.pdf', size: 5 }] } });
  w.a3.lostAnswers.push(method => method === 'Upload');
  const before = structuredClone(w.state);
  await expect(w.def.dispatch!(w.ctx, event)).rejects.toThrow('answer was lost');
  w.state.clear(); for (const [key, value] of before) w.state.set(key, value); // platform discards failed call-state
  await w.def.dispatch!(w.ctx, event);
  await w.def.dispatch!(w.ctx, event);
  expect(w.a3.docs).toHaveLength(1);
  expect(w.a3.calls.filter(c => c.method === 'Upload')).toHaveLength(1);
});

it('wire probes are inconclusive for transport failures and never ask for scope authority', async () => {
  const w = world();
  const called = () => { throw new Error('scope must not be reached by a probe'); };
  const response = await runConnectorCall({ role: 'probe-candidate', provider: A3DOC_VERTICAL_PROVIDER, secret: w.ctx.secret }, {
    connectors: defineConnectors({ [A3DOC_VERTICAL_PROVIDER]: w.def }), fetch: async () => { throw new Error('offline'); },
    host: { connectorInvokeLocal: called, connectorAttachmentUploadLocal: called, connectorAttachmentOpenLocal: called },
  });
  expect(response).toMatchObject({ ok: true, result: { ok: false, refused: false } });
});

it('resumes hosted sweeps in bounded pages without exceeding the outbound-use ceiling', async () => {
  const w = world();
  for (let i = 0; i < 55; i++) w.a3.add([21], `Invoice ${i}`, `bytes ${i}`);
  await w.bind('Facturas/Recibidas');
  const more: boolean[] = [];
  for (let i = 0; i < 3; i++) {
    const before = w.a3.calls.length;
    const result = await w.def.sweep!(w.ctx);
    expect(w.a3.calls.length - before).toBeLessThan(100);
    more.push(result?.more ?? false);
  }
  expect(more).toEqual([true, true, false]);
  expect(w.changes.filter(c => c.kind === 'file' && c.change === 'upsert')).toHaveLength(55);
});
