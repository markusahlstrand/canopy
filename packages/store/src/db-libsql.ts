import { createClient, type Client, type InArgs } from "@libsql/client";
import type { Db } from "./db";

/**
 * {@link Db} over libsql (SQLite) for the Node / Docker target. Pass a libsql
 * URL — `file:./data/canopy.db` for a local file, or a Turso URL.
 */
export function createLibsqlDb(url: string, authToken?: string): Db {
  const client: Client = createClient({ url, authToken });
  return {
    async run(sql, params = []) {
      const res = await client.execute({ sql, args: params as InArgs });
      return { rowsAffected: res.rowsAffected };
    },
    async first<T>(sql: string, params: unknown[] = []) {
      const res = await client.execute({ sql, args: params as InArgs });
      return (res.rows[0] as T | undefined) ?? null;
    },
    async all<T>(sql: string, params: unknown[] = []) {
      const res = await client.execute({ sql, args: params as InArgs });
      return res.rows as unknown as T[];
    },
    async batch(statements) {
      await client.batch(
        statements.map((s) => ({ sql: s.sql, args: (s.params ?? []) as InArgs })),
        "write",
      );
    },
  };
}
