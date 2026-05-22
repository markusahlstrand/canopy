import type { Db } from "./db";

/**
 * Structural type for a D1 database binding — just what this adapter uses, so we
 * avoid a dependency on @cloudflare/workers-types. A real `D1Database` satisfies it.
 */
export interface D1Like {
  prepare(sql: string): D1PreparedLike;
  batch(statements: D1PreparedLike[]): Promise<unknown[]>;
}
export interface D1PreparedLike {
  bind(...values: unknown[]): D1PreparedLike;
  run(): Promise<{ meta?: { changes?: number } }>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

/** {@link Db} over a Cloudflare D1 binding. */
export function createD1Db(d1: D1Like): Db {
  return {
    async run(sql, params = []) {
      const res = await d1.prepare(sql).bind(...params).run();
      return { rowsAffected: res.meta?.changes ?? 0 };
    },
    first<T>(sql: string, params: unknown[] = []) {
      return d1.prepare(sql).bind(...params).first<T>();
    },
    async all<T>(sql: string, params: unknown[] = []) {
      const res = await d1.prepare(sql).bind(...params).all<T>();
      return res.results;
    },
    async batch(statements) {
      await d1.batch(statements.map((s) => d1.prepare(s.sql).bind(...(s.params ?? []))));
    },
  };
}
