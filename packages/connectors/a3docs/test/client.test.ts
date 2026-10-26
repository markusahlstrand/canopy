import { describe, expect, it } from 'vitest';
import { createA3docClient, A3docError, bytesToBase64, base64ToBytes, canUploadAs, isAmbiguousA3Date, parseA3Date } from '../src/client.js';

describe('parseA3Date', () => {
  it('reads Spanish wall-clock time in Europe/Madrid across the DST change', () => {
    expect(parseA3Date('15/01/2026 12:00:00')).toBe('2026-01-15T11:00:00.000Z'); // CET, UTC+1
    expect(parseA3Date('15/07/2026 12:00')).toBe('2026-07-15T10:00:00.000Z'); // CEST, UTC+2
    expect(parseA3Date('21/10/2026')).toBe('2026-10-20T22:00:00.000Z');
    expect(parseA3Date('2026-10-21')).toBeUndefined();
    expect(parseA3Date(undefined)).toBeUndefined();
  });
});

describe('isAmbiguousA3Date', () => {
  it('is true only inside the hour the clocks go back', () => {
    // 2026-10-25: 03:00 CEST becomes 02:00 CET, so 02:00-02:59 happens twice.
    expect(isAmbiguousA3Date('25/10/2026 02:30:00')).toBe(true);
    expect(isAmbiguousA3Date('25/10/2026 01:30:00')).toBe(false);
    expect(isAmbiguousA3Date('25/10/2026 03:30:00')).toBe(false);
    // The spring-forward hour is skipped, not repeated.
    expect(isAmbiguousA3Date('29/03/2026 02:30:00')).toBe(false);
    expect(isAmbiguousA3Date(undefined)).toBe(false);
  });
});

describe('bytes', () => {
  it('round-trips through base64, including a body larger than one chunk', () => {
    const big = Uint8Array.from({ length: 70_000 }, (_, i) => i % 251);
    expect(base64ToBytes(bytesToBase64(big))).toEqual(big);
  });
});

it('treats the roles the web app hides its upload page from as read-only', () => {
  expect(canUploadAs(1)).toBe(false);
  expect(canUploadAs(6)).toBe(false);
  expect(canUploadAs(5)).toBe(true);
});


describe('response validation', () => {
  const invalid = [
    { status: 502, body: '{"errorCode":0}', error: 'HTTP 502' },
    { status: 200, body: '{"message":"Bad Gateway"}', error: 'no numeric errorCode' },
    { status: 200, body: '{"errorCode":"0"}', error: 'no numeric errorCode' },
    { status: 200, body: 'null', error: 'no numeric errorCode' },
    { status: 200, body: '[]', error: 'no numeric errorCode' },
    { status: 200, body: '<html>gateway</html>', error: 'expected JSON' },
  ];
  it.each(invalid)('rejects $status / $body for sign-in, listings, searches and downloads', async ({ status, body, error }) => {
    let response = { status: 200, body: '{"errorCode":0,"token":"session"}' };
    const client = createA3docClient({
      credentials: { companyCode: 'company', user: 'user', password: 'password' },
      apiBase: 'https://a3.example/v1',
      fetch: async () => ({ status: response.status, text: async () => response.body }),
    });
    await client.signIn();
    response = { status, body };
    const actions = [
      () => client.signIn(),
      () => client.listDocuments({ containerId: 1, children: true, pageIndex: 0, pageSize: 100 }),
      () => client.findByTitle({ containerId: 1, children: false, title: 'Invoice' }),
      () => client.download('doc'),
    ];
    for (const action of actions) {
      await expect(action()).rejects.toThrow(error);
      await expect(action()).rejects.not.toBeInstanceOf(A3docError);
    }
  });
});


describe('document payload validation', () => {
  const clientFor = (payload: unknown) => createA3docClient({
    credentials: { companyCode: 'company', user: 'user', password: 'password' },
    apiBase: 'https://a3.example/v1',
    fetch: async (url) => ({ status: 200, text: async () => JSON.stringify(
      url.endsWith('/signIn') ? { errorCode: 0, token: 'session' } : payload,
    ) }),
  });
  it.each([
    { errorCode: 0, countAllDocuments: 1 },
    { errorCode: 0, documents: null },
    { errorCode: 0, documents: [{}] },
    { errorCode: 0, documents: [{ Id: 'doc', ContainersId: '21' }] },
  ])('rejects incomplete listings and searches: %j', async (payload) => {
    const client = clientFor(payload);
    await expect(client.listDocuments({ containerId: 1, children: true, pageIndex: 0, pageSize: 100 })).rejects.toThrow('invalid documents');
    await expect(client.findByTitle({ containerId: 1, children: false, title: 'Invoice' })).rejects.toThrow('invalid documents');
  });
  it('requires a listing count and successful download content', async () => {
    await expect(clientFor({ errorCode: 0, documents: [] }).listDocuments({ containerId: 1, children: true, pageIndex: 0, pageSize: 100 }))
      .rejects.toThrow('invalid document count');
    await expect(clientFor({ errorCode: 0 }).download('doc')).rejects.toThrow('missing content');
    expect(await clientFor({ errorCode: 2 }).download('doc')).toBeNull();
    expect(await clientFor({ errorCode: 0, content: '' }).download('doc')).toEqual(new Uint8Array());
    expect(await clientFor({ errorCode: 0, documents: [], countAllDocuments: 0 })
      .listDocuments({ containerId: 1, children: true, pageIndex: 0, pageSize: 100 })).toEqual({ total: 0, documents: [] });
  });
});
