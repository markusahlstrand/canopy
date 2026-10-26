import { describe, expect, it } from 'vitest';
import { bytesToBase64, base64ToBytes, canUploadAs, isAmbiguousA3Date, parseA3Date } from '../src/client.js';

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
