/**
 * The scope side of automation: the queue every arrival writes, file categories, flows and
 * what they did. Everything that runs a model, crosses to another space or moves bytes is the
 * worker's (`apps/drive-vertical/src/automation.ts`); this file only keeps the records, so each
 * of them changes in one scope transaction.
 *
 * **Why a queue table and not an event consumer.** A version arrives through four doors (the
 * upload route, WebDAV, a connector's sync, mail), and only the first two pass through worker
 * code that could start a job. The row is written in the arrival's own transaction, so a sync
 * that lands a hundred statements queues a hundred rows or none, and the worker's dispatcher,
 * kicked after an upload or by the sweeper, drains them.
 */
import { substratError, type HandlerInput, type HandlerOutput } from '@substrat-run/contracts';
import { assertAllowed, ulid, type OperationContext, type OperationHandler } from '@substrat-run/kernel';
import { DRIVE_PERM } from './manifest.js';
import {
  flowDefinition,
  scheduleDue,
  type driveOperations,
  type DeliveryState,
  type FileCategory,
  type FileFactsRow,
  type FlowDelivery,
  type StoredFlow,
} from '../spec/model.js';

const fileRef = (id: string) => ({ entityType: 'file', entityId: id }) as const;

/** A version arrived. `actor` is the person whose write it was; null for a sync or mail. */
export function queueArrival(ctx: OperationContext, fileId: string, versionId: string, actor: string | null): void {
  ctx.sql.exec(
    "INSERT INTO drive_automation_queue (file_id, version_id, trigger, actor, queued_at) VALUES (?, ?, 'arrived', ?, ?)",
    [fileId, versionId, actor, ctx.now()],
  );
}

function queueClassified(ctx: OperationContext, fileId: string, versionId: string | null, actor: string | null): void {
  ctx.sql.exec(
    "INSERT INTO drive_automation_queue (file_id, version_id, trigger, actor, queued_at) VALUES (?, ?, 'classified', ?, ?)",
    [fileId, versionId, actor, ctx.now()],
  );
}

type CategoryRow = { file_id: string; category: string | null; confidence: number | null; source: 'ai' | 'person'; version_id: string | null };
const categoryOf = (row: CategoryRow | undefined): FileCategory | null =>
  row ? { id: row.category, confidence: row.confidence, source: row.source, versionId: row.version_id } : null;

export function readCategory(ctx: OperationContext, fileId: string): FileCategory | null {
  return categoryOf(ctx.sql.query<CategoryRow>('SELECT * FROM drive_file_categories WHERE file_id = ?', [fileId])[0]);
}

/**
 * The category as flows see it: Document AI's choice describes the version it read, so it does not
 * describe a newer one until the model has read that too. A person's choice stands for the file.
 */
function currentCategory(category: FileCategory | null, versionId: string | null): FileCategory | null {
  return category?.source === 'ai' && category.versionId !== versionId ? null : category;
}

type PendingRow = { file_id: string; last_error: string | null; failed_at: string | null; attempts: number };
/** A send to the source still out, and how its last try went. */
export function readSend(ctx: OperationContext, fileId: string) {
  const row = ctx.sql.query<PendingRow>('SELECT file_id, last_error, failed_at, attempts FROM drive_source_pending WHERE file_id = ?', [fileId])[0];
  if (!row) return null;
  return { state: row.last_error ? 'failed' as const : 'sending' as const, error: row.last_error, failedAt: row.failed_at, attempts: row.attempts };
}

type OriginRow = { flow_id: string; source_scope: string; source_file_id: string; source_version_id: string; created_at: string };
export function readOrigin(ctx: OperationContext, fileId: string) {
  const row = ctx.sql.query<OriginRow>('SELECT * FROM drive_file_origins WHERE file_id = ?', [fileId])[0];
  return row ? { flowId: row.flow_id, sourceScope: row.source_scope, sourceFileId: row.source_file_id, sourceVersionId: row.source_version_id, createdAt: row.created_at } : null;
}

type FactsRow = {
  id: string; name: string; folder_id: string; state: string; current_version_id: string | null; path: string;
  blob_ref: string | null; mime: string | null; size: number | null; version_created_at: string | null;
  labels_json: string | null; origin: string | null;
};
const FACTS_SQL = `
  SELECT f.id, f.name, f.folder_id, f.state, f.current_version_id, fo.path,
         v.blob_ref, v.mime, v.size, v.created_at AS version_created_at,
         d.labels_json, o.flow_id AS origin
    FROM drive_files f
    JOIN drive_folders fo ON fo.id = f.folder_id
    LEFT JOIN drive_file_versions v ON v.id = f.current_version_id
    LEFT JOIN drive_file_details d ON d.file_id = f.id
    LEFT JOIN drive_file_origins o ON o.file_id = f.id`;

function factsFrom(ctx: OperationContext, row: FactsRow): FileFactsRow {
  let labels: string[] = [];
  try { labels = row.labels_json ? (JSON.parse(row.labels_json) as string[]) : []; } catch { labels = []; }
  return {
    fileId: row.id, name: row.name, folderId: row.folder_id, folderPath: row.path, state: row.state,
    versionId: row.current_version_id, blobRef: row.blob_ref, mime: row.mime, size: row.size, versionCreatedAt: row.version_created_at,
    labels, category: currentCategory(readCategory(ctx, row.id), row.current_version_id), copiedByFlow: row.origin !== null,
  };
}

function factsOf(ctx: OperationContext, fileId: string): FileFactsRow | null {
  const row = ctx.sql.query<FactsRow>(`${FACTS_SQL} WHERE f.id = ?`, [fileId])[0];
  return row ? factsFrom(ctx, row) : null;
}

type FlowRow = {
  id: string; name: string; enabled: number; definition_json: string; author: string; author_sub: string;
  created_at: string; updated_at: string; last_run_at: string | null; failures: number; paused_reason: string | null;
};

/** A stored flow, or null when its definition no longer parses (an older shape): it is shown as broken, never run. */
function flowFrom(row: FlowRow): (StoredFlow & { authorSub: string }) | null {
  let raw: unknown;
  try { raw = JSON.parse(row.definition_json); } catch { return null; }
  const definition = flowDefinition.safeParse(raw);
  if (!definition.success) return null;
  return {
    id: row.id, name: row.name, enabled: row.enabled === 1, definition: definition.data, author: row.author,
    createdAt: row.created_at, updatedAt: row.updated_at, lastRunAt: row.last_run_at, failures: row.failures,
    pausedReason: row.paused_reason, authorSub: row.author_sub,
  };
}

const flowRows = (ctx: OperationContext) => ctx.sql.query<FlowRow>('SELECT * FROM drive_flows ORDER BY created_at, id');
const publicFlow = ({ authorSub: _sub, ...flow }: StoredFlow & { authorSub: string }): StoredFlow => flow;

type DeliveryRow = {
  flow_id: string; file_id: string; version_id: string; state: DeliveryState; detail_json: string;
  attempts: number; created_at: string; updated_at: string; name?: string | null;
};
const deliveryFrom = (row: DeliveryRow): FlowDelivery => {
  let detail: Record<string, unknown> = {};
  try { detail = JSON.parse(row.detail_json) as Record<string, unknown>; } catch { detail = {}; }
  return {
    flowId: row.flow_id, fileId: row.file_id, versionId: row.version_id, fileName: row.name ?? null, state: row.state,
    detail, attempts: row.attempts, createdAt: row.created_at, updatedAt: row.updated_at,
  };
};

/** After this many failures in a row a flow stops itself, and says why. */
export const FLOW_FAILURE_LIMIT = 5;

type Ops = typeof driveOperations;
type AutomationOp =
  | 'drive/set-file-category' | 'drive/list-flows' | 'drive/save-flow' | 'drive/delete-flow' | 'drive/flow-deliveries'
  | 'drive/automation-flows' | 'drive/automation-pending' | 'drive/automation-claim' | 'drive/automation-ack'
  | 'drive/file-facts' | 'drive/flow-candidates' | 'drive/record-flow-delivery' | 'drive/flow-ran' | 'drive/record-file-origin';

export const automationHandlers = {
  'drive/set-file-category': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.write, fileRef(input.fileId)));
    const file = ctx.sql.query<{ state: string; current_version_id: string | null }>('SELECT state, current_version_id FROM drive_files WHERE id = ?', [input.fileId])[0];
    if (!file || file.state !== 'live') throw substratError('not_found', `file not found: ${input.fileId}`);
    if (input.expectedVersionId !== undefined && input.expectedVersionId !== file.current_version_id) {
      throw substratError('conflict', 'file content changed — this category describes an older version');
    }
    const before = ctx.sql.query<CategoryRow>('SELECT * FROM drive_file_categories WHERE file_id = ?', [input.fileId])[0];
    // A person decided; the model's later guess is not a correction.
    if (input.source === 'ai' && before?.source === 'person') return { fileId: input.fileId, category: categoryOf(before), changed: false };
    const confidence = input.source === 'person' ? null : (input.confidence ?? null);
    const versionId = file.current_version_id;
    const same = before && before.category === input.category && before.source === input.source
      && before.version_id === versionId && (before.confidence ?? null) === confidence;
    if (same) return { fileId: input.fileId, category: categoryOf(before), changed: false };
    // A person clearing a category hands the file back to the AI rather than pinning "none".
    if (input.source === 'person' && input.category === null) {
      ctx.sql.exec('DELETE FROM drive_file_categories WHERE file_id = ?', [input.fileId]);
    } else {
      ctx.sql.exec(`INSERT INTO drive_file_categories (file_id, category, confidence, source, version_id, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(file_id) DO UPDATE SET category = excluded.category, confidence = excluded.confidence,
        source = excluded.source, version_id = excluded.version_id, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [input.fileId, input.category, confidence, input.source, versionId, ctx.now(), ctx.principal]);
    }
    const after = readCategory(ctx, input.fileId);
    ctx.emit({ type: 'drive.file-classified', schemaVersion: 1, entity: fileRef(input.fileId), piiClass: 'none', payload: { fileId: input.fileId } });
    // Only a category is something a flow can react to; clearing one starts nothing.
    if (after?.id) queueClassified(ctx, input.fileId, versionId, input.source === 'person' ? ctx.principal : null);
    return { fileId: input.fileId, category: after, changed: true };
  },

  'drive/list-flows': async (ctx) => {
    assertAllowed(await ctx.check(DRIVE_PERM.manage));
    return { flows: flowRows(ctx).map(flowFrom).filter((f): f is NonNullable<typeof f> => !!f).map(publicFlow) };
  },

  'drive/save-flow': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.manage));
    const now = ctx.now();
    const definition = JSON.stringify(input.definition);
    let id = input.id;
    if (id) {
      const prior = ctx.sql.query<FlowRow>('SELECT * FROM drive_flows WHERE id = ?', [id])[0];
      if (!prior) throw substratError('not_found', `flow not found: ${id}`);
      // Saving is taking it on: the flow acts as whoever saved it last, and starts over unpaused.
      ctx.sql.exec(`UPDATE drive_flows SET name = ?, enabled = ?, definition_json = ?, author = ?, author_sub = ?, updated_at = ?,
        failures = 0, paused_reason = NULL WHERE id = ?`, [input.name, input.enabled ? 1 : 0, definition, ctx.principal, input.authorSub, now, id]);
    } else {
      if (flowRows(ctx).length >= 50) throw substratError('conflict', 'a space holds at most 50 flows');
      id = ulid();
      ctx.sql.exec(`INSERT INTO drive_flows (id, name, enabled, definition_json, author, author_sub, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [id, input.name, input.enabled ? 1 : 0, definition, ctx.principal, input.authorSub, now, now]);
    }
    const row = ctx.sql.query<FlowRow>('SELECT * FROM drive_flows WHERE id = ?', [id])[0]!;
    return publicFlow(flowFrom(row)!);
  },

  'drive/delete-flow': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.manage));
    ctx.sql.exec('DELETE FROM drive_flow_deliveries WHERE flow_id = ?', [input.id]);
    ctx.sql.exec('DELETE FROM drive_flows WHERE id = ?', [input.id]);
    return { ok: true as const };
  },

  'drive/flow-deliveries': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.manage));
    const where: string[] = [], args: string[] = [];
    if (input.flowId) { where.push('d.flow_id = ?'); args.push(input.flowId); }
    if (input.state) { where.push('d.state = ?'); args.push(input.state); }
    if (input.fileId) { where.push('d.file_id = ?'); args.push(input.fileId); }
    const rows = ctx.sql.query<DeliveryRow>(
      `SELECT d.*, f.name FROM drive_flow_deliveries d LEFT JOIN drive_files f ON f.id = d.file_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.updated_at DESC LIMIT ?`,
      [...args, input.limit ?? 50],
    );
    return { deliveries: rows.map(deliveryFrom) };
  },

  'drive/automation-flows': async (ctx) => {
    assertAllowed(await ctx.check(DRIVE_PERM.manage));
    return { flows: flowRows(ctx).map(flowFrom).filter((f): f is NonNullable<typeof f> => !!f) };
  },

  'drive/automation-pending': async (ctx) => {
    assertAllowed(await ctx.check(DRIVE_PERM.manage));
    const queued = ctx.sql.query<{ n: number }>('SELECT COUNT(*) AS n FROM drive_automation_queue')[0]?.n ?? 0;
    const now = Date.parse(ctx.now());
    const dueSchedules = flowRows(ctx).map(flowFrom)
      .filter((f) => f && f.enabled && !f.pausedReason && scheduleDue(f.definition.trigger, f.lastRunAt, now)).length;
    return { queued, dueSchedules };
  },

  'drive/automation-claim': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.manage));
    const rows = ctx.sql.query<{ seq: number; file_id: string; version_id: string | null; trigger: 'arrived' | 'classified'; actor: string | null }>(
      'SELECT seq, file_id, version_id, trigger, actor FROM drive_automation_queue ORDER BY seq LIMIT ?', [input.limit ?? 25],
    );
    return { items: rows.map((r) => ({ seq: r.seq, fileId: r.file_id, versionId: r.version_id, trigger: r.trigger, actor: r.actor, file: factsOf(ctx, r.file_id) })) };
  },

  'drive/automation-ack': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.manage));
    const n = ctx.sql.query<{ n: number }>('SELECT COUNT(*) AS n FROM drive_automation_queue WHERE seq <= ?', [input.upTo])[0]?.n ?? 0;
    ctx.sql.exec('DELETE FROM drive_automation_queue WHERE seq <= ?', [input.upTo]);
    return { dropped: n };
  },

  'drive/file-facts': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.read, fileRef(input.fileId)));
    const facts = factsOf(ctx, input.fileId);
    if (!facts) throw substratError('not_found', `file not found: ${input.fileId}`);
    return facts;
  },

  'drive/flow-candidates': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.manage));
    const limit = input.limit ?? 100;
    const rows = ctx.sql.query<FactsRow>(
      `${FACTS_SQL} WHERE f.state = 'live' AND v.id IS NOT NULL AND (? IS NULL OR v.created_at > ?) AND f.id > ?
        ORDER BY f.id LIMIT ?`,
      [input.since, input.since, input.after ?? '', limit + 1],
    );
    const page = rows.slice(0, limit);
    return { files: page.map((r) => factsFrom(ctx, r)), next: rows.length > limit ? page[page.length - 1]!.id : null };
  },

  'drive/record-flow-delivery': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.manage));
    const flow = ctx.sql.query<FlowRow>('SELECT * FROM drive_flows WHERE id = ?', [input.flowId])[0];
    if (!flow) throw substratError('not_found', `flow not found: ${input.flowId}`);
    const key = [input.flowId, input.fileId, input.versionId];
    const prior = ctx.sql.query<DeliveryRow>('SELECT * FROM drive_flow_deliveries WHERE flow_id = ? AND file_id = ? AND version_id = ?', key)[0];
    const previous = prior?.state ?? 'none';
    const read = () => {
      const row = ctx.sql.query<DeliveryRow>(
        `SELECT d.*, f.name FROM drive_flow_deliveries d LEFT JOIN drive_files f ON f.id = d.file_id
          WHERE d.flow_id = ? AND d.file_id = ? AND d.version_id = ?`, key)[0];
      return row ? deliveryFrom(row) : null;
    };
    if (input.expect && !input.expect.includes(previous)) return { delivery: read(), changed: false, previous };
    const now = ctx.now();
    const detail = JSON.stringify(input.detail ?? (prior ? JSON.parse(prior.detail_json) : {}));
    const attempts = (prior?.attempts ?? 0) + (input.state === 'running' ? 1 : 0);
    ctx.sql.exec(`INSERT INTO drive_flow_deliveries (flow_id, file_id, version_id, state, detail_json, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(flow_id, file_id, version_id) DO UPDATE SET
      state = excluded.state, detail_json = excluded.detail_json, attempts = excluded.attempts, updated_at = excluded.updated_at`,
    [...key, input.state, detail, attempts, now, now]);
    if (input.state === 'done') ctx.sql.exec('UPDATE drive_flows SET failures = 0 WHERE id = ?', [input.flowId]);
    if (input.state === 'failed') {
      const failures = flow.failures + 1;
      const paused = failures >= FLOW_FAILURE_LIMIT
        ? `Paused after ${failures} failures in a row. Last: ${String((input.detail as { error?: unknown } | undefined)?.error ?? 'unknown error').slice(0, 300)}`
        : null;
      ctx.sql.exec('UPDATE drive_flows SET failures = ?, paused_reason = COALESCE(paused_reason, ?) WHERE id = ?', [failures, paused, input.flowId]);
    }
    return { delivery: read(), changed: true, previous };
  },

  'drive/flow-ran': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.manage));
    ctx.sql.exec('UPDATE drive_flows SET last_run_at = ? WHERE id = ?', [input.at, input.flowId]);
    return { ok: true as const };
  },

  'drive/record-file-origin': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.write, fileRef(input.fileId)));
    const file = ctx.sql.query<{ state: string }>('SELECT state FROM drive_files WHERE id = ?', [input.fileId])[0];
    if (!file || file.state !== 'live') throw substratError('not_found', `file not found: ${input.fileId}`);
    ctx.sql.exec(`INSERT INTO drive_file_origins (file_id, flow_id, source_scope, source_file_id, source_version_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(file_id) DO UPDATE SET source_version_id = excluded.source_version_id
      WHERE drive_file_origins.flow_id = excluded.flow_id AND drive_file_origins.source_file_id = excluded.source_file_id`,
    [input.fileId, input.flowId, input.sourceScope, input.sourceFileId, input.sourceVersionId, ctx.now()]);
    return { ok: true as const };
  },
} satisfies {
  [K in AutomationOp]: OperationHandler<HandlerInput<Ops[K]>, HandlerOutput<Ops[K]>>;
};
