/** Pure SQL rules, called inside one synchronous identity-DO transaction. */
export interface DirectorySql { exec(query: string, ...values: (string | number | null)[]): Iterable<Record<string, unknown>> }
export function bindSpaceCreator(sql: DirectorySql, scope: string, owner: string, subject: string): void {
  sql.exec('CREATE TABLE IF NOT EXISTS canopy_creator_claims (scope_id TEXT PRIMARY KEY)');
  if ([...sql.exec('SELECT 1 FROM canopy_creator_claims WHERE scope_id = ?', scope)].length) return;
  const record = [...sql.exec('SELECT principal FROM owner_of_record WHERE scope_id = ?', scope)][0];
  const pending = [...sql.exec('SELECT principal FROM pending_owner WHERE scope_id = ?', scope)][0];
  // Claimed/transferred seats must never be reopened or rebound by reconciliation.
  if (record && (record.principal !== owner || !pending)) return;
  const existing = [...sql.exec('SELECT principal FROM identity WHERE scope_id = ? AND sub = ?', scope, subject)][0];
  if (existing && existing.principal !== owner) throw new Error('Creator already has a different principal.');
  sql.exec('INSERT OR IGNORE INTO owner_of_record (scope_id, principal) VALUES (?, ?)', scope, owner);
  sql.exec('INSERT OR IGNORE INTO identity (scope_id, sub, principal) VALUES (?, ?, ?)', scope, subject, owner);
  sql.exec('DELETE FROM pending_owner WHERE scope_id = ?', scope);
  sql.exec('DELETE FROM owner_claim WHERE scope_id = ?', scope);
  sql.exec('INSERT INTO canopy_creator_claims (scope_id) VALUES (?)', scope);
}
export function reserveSpaceCreation(sql: DirectorySql, slug: string, subject: string, owner: string, now: number): {owner: string; error?: 'cap' | 'rate' | 'conflict'} {
  sql.exec('CREATE TABLE IF NOT EXISTS canopy_space_requests (slug TEXT PRIMARY KEY, subject TEXT NOT NULL, owner TEXT NOT NULL, created_at INTEGER NOT NULL)');
  const existing = [...sql.exec('SELECT owner, subject FROM canopy_space_requests WHERE slug = ?', slug)][0];
  if (existing) return existing.subject === subject ? {owner: String(existing.owner)} : {owner, error:'conflict'};
  const total = [...sql.exec('SELECT COUNT(*) AS n FROM (SELECT slug FROM site UNION SELECT slug FROM canopy_space_requests)')][0];
  if (Number(total?.n) >= 100) return {owner, error:'cap'};
  const recent = [...sql.exec('SELECT COUNT(*) AS n FROM canopy_space_requests WHERE subject = ? AND created_at > ?', subject, now - 3600000)][0];
  if (Number(recent?.n) >= 10) return {owner, error:'rate'};
  sql.exec('INSERT INTO canopy_space_requests (slug, subject, owner, created_at) VALUES (?, ?, ?, ?)', slug, subject, owner, now);
  return {owner};
}
