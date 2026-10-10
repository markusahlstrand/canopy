/// <reference types="node" />
import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { DirectorySql } from '../src/space-creation';
import {
  MAX_APP_PASSWORDS, appPasswordName, createAppPassword, listAppPasswords, mintAppPassword, revokeAppPassword, verifyAppPassword,
} from '../src/app-passwords';

function database() {
  const db = new DatabaseSync(':memory:');
  const sql: DirectorySql = {
    exec: (query, ...values) => {
      const stmt = db.prepare(query);
      return stmt.columns().length ? stmt.all(...values) : (stmt.run(...values), []);
    },
  };
  return { db, sql };
}

it('verifies a password to its subject, lists it for that subject only, and stops after revocation', () => {
  const { db, sql } = database();
  createAppPassword(sql, { id: 'a', sub: 'ada', name: 'Finder', tokenHash: 'hash-a', now: 1 });
  createAppPassword(sql, { id: 'b', sub: 'bjorn', name: 'Explorer', tokenHash: 'hash-b', now: 2 });
  expect(verifyAppPassword(sql, 'hash-a', 10)).toBe('ada');
  expect(verifyAppPassword(sql, 'unknown', 10)).toBeNull();
  expect(listAppPasswords(sql, 'ada')).toEqual([{ id: 'a', name: 'Finder', created_at: 1, last_used_at: 10 }]);
  // Another login cannot revoke it, even knowing the id.
  expect(revokeAppPassword(sql, 'bjorn', 'a')).toBe(false);
  expect(verifyAppPassword(sql, 'hash-a', 20)).toBe('ada');
  expect(revokeAppPassword(sql, 'ada', 'a')).toBe(true);
  expect(verifyAppPassword(sql, 'hash-a', 30)).toBeNull();
  expect(listAppPasswords(sql, 'ada')).toEqual([]);
  db.close();
});

it('records last use at most once a minute', () => {
  const { db, sql } = database();
  createAppPassword(sql, { id: 'a', sub: 'ada', name: 'Finder', tokenHash: 'h', now: 0 });
  verifyAppPassword(sql, 'h', 1_000);
  verifyAppPassword(sql, 'h', 30_000);
  expect(listAppPasswords(sql, 'ada')[0]?.last_used_at).toBe(1_000);
  verifyAppPassword(sql, 'h', 61_000);
  expect(listAppPasswords(sql, 'ada')[0]?.last_used_at).toBe(61_000);
  db.close();
});

it('caps passwords per login', () => {
  const { db, sql } = database();
  for (let i = 0; i < MAX_APP_PASSWORDS; i++) createAppPassword(sql, { id: `p${i}`, sub: 'ada', name: 'x', tokenHash: `h${i}`, now: i });
  expect(createAppPassword(sql, { id: 'over', sub: 'ada', name: 'x', tokenHash: 'over', now: 99 })).toEqual({ error: 'limit' });
  expect(createAppPassword(sql, { id: 'other', sub: 'bjorn', name: 'x', tokenHash: 'other', now: 99 })).toMatchObject({ id: 'other' });
  db.close();
});

it('mints distinct high-entropy secrets and cleans names', () => {
  const a = mintAppPassword();
  expect(a).toMatch(/^canopy_[A-Za-z0-9_-]{43}$/);
  expect(mintAppPassword()).not.toBe(a);
  expect(appPasswordName('  My\nMac  ')).toBe('My Mac');
  expect(appPasswordName('')).toBeNull();
  expect(appPasswordName('x'.repeat(61))).toBeNull();
  expect(appPasswordName(5)).toBeNull();
});
