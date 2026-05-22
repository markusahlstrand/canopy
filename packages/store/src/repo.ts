import type { Db } from "./db";
import type { BlobRepo } from "./blob-store";
import type { BlobRecord } from "./types";

interface BlobRow {
  hash: string;
  size: number;
  ref_count: number;
  created_at: string;
}

const toBlob = (r: BlobRow): BlobRecord => ({
  key: r.hash,
  size: r.size,
  refCount: r.ref_count,
  createdAt: r.created_at,
});

/** SQL-backed {@link BlobRepo} over any {@link Db}. The `blobs.hash` column holds the storage key. */
export function createSqlBlobRepo(db: Db): BlobRepo {
  return {
    async find(key) {
      const row = await db.first<BlobRow>("SELECT hash, size, ref_count, created_at FROM blobs WHERE hash = ?", [key]);
      return row ? toBlob(row) : null;
    },
    async insertOrIncrement(key, size, now) {
      const row = await db.first<{ ref_count: number }>(
        `INSERT INTO blobs (hash, size, ref_count, created_at) VALUES (?, ?, 1, ?)
         ON CONFLICT(hash) DO UPDATE SET ref_count = ref_count + 1
         RETURNING ref_count`,
        [key, size, now],
      );
      return row?.ref_count ?? 1;
    },
    async increment(key) {
      const row = await db.first<{ ref_count: number }>(
        "UPDATE blobs SET ref_count = ref_count + 1 WHERE hash = ? RETURNING ref_count",
        [key],
      );
      return row ? row.ref_count : null;
    },
    async decrement(key) {
      const row = await db.first<{ ref_count: number }>(
        "UPDATE blobs SET ref_count = ref_count - 1 WHERE hash = ? RETURNING ref_count",
        [key],
      );
      return row ? row.ref_count : null;
    },
    async delete(key) {
      await db.run("DELETE FROM blobs WHERE hash = ?", [key]);
    },
    async zeroRefKeys(limit = 100) {
      const rows = await db.all<{ hash: string }>("SELECT hash FROM blobs WHERE ref_count <= 0 LIMIT ?", [limit]);
      return rows.map((r) => r.hash);
    },
  };
}
