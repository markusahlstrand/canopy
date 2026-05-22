/**
 * Minimal async SQL executor. Both targets implement it: D1 on Cloudflare,
 * libsql (SQLite) on Node. Statements use positional `?` placeholders.
 *
 * Refcount mutations are written as single `RETURNING` statements so they're
 * atomic on both backends without interactive transactions; multi-row writes
 * that must be all-or-nothing use `batch()`.
 */
export interface Db {
  /** Execute a write; returns the number of affected rows. */
  run(sql: string, params?: unknown[]): Promise<{ rowsAffected: number }>;
  /** First row of a query (or a `RETURNING` write), or null. */
  first<T>(sql: string, params?: unknown[]): Promise<T | null>;
  /** All rows of a query. */
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run statements as one atomic batch. */
  batch(statements: { sql: string; params?: unknown[] }[]): Promise<void>;
}
