/**
 * The space's knowledge graph: claims read from documents, and the people, organisations and
 * places they are about (`spec/ontology.ts` for the vocabulary, migration 0018 for the tables).
 *
 * Rules that keep it trustworthy:
 *
 *  - **Claims, not facts.** A model reading becomes a `suggested` claim. Only a person makes it
 *    `accepted`. Nothing is overwritten: a newer one-value claim *supersedes* the older one,
 *    which stays as history.
 *  - **The vocabulary is closed.** A predicate, entity type or value the vocabulary does not
 *    know is dropped here, whatever the caller sent. A value with a bad checksum is a misread
 *    and is dropped too.
 *  - **Same value, same entity.** An extracted entity is matched to an existing one by a
 *    match-key value (VAT id, NIF, email, IBAN, …) first, then by its normalised name. Match
 *    keys are claims themselves, so there is no second table that can drift from them.
 *  - **Decided once.** A statement already accepted elsewhere is recorded as corroboration, not
 *    asked again; one already rejected is not suggested again.
 *  - **You see what your documents say.** Every claim carries the file it was read from, and a
 *    claim, an entity or a connection is visible only through a live file the caller can read.
 *    A per-space graph joined at read time therefore never shows more than the reader's own
 *    access — the same rule a cross-space view will follow.
 */
import { substratError, type HandlerInput, type HandlerOutput } from '@substrat-run/contracts';
import { assertAllowed, ulid, type OperationContext, type OperationHandler } from '@substrat-run/kernel';
import { DRIVE_PERM } from './manifest.js';
import {
  allowsObjectEntity, allowsSubject, isEntityType, nameKey, normalizeValue, predicateById,
  type driveOperations, type EntityType, type GraphClaim, type GraphEntity, type GraphNode, type SubjectType, type ValueKind,
} from '../spec/model.js';

const fileRef = (id: string) => ({ entityType: 'file', entityId: id }) as const;
const DOCUMENT = 'document';

type EntityRow = { id: string; type: EntityType; name: string; name_key: string; status: 'suggested' | 'accepted'; merged_into: string | null };
type ClaimRow = {
  id: string; subject_type: 'document' | 'entity'; subject_id: string; predicate: string;
  object_entity_id: string | null; object_kind: string; object_value: string | null;
  file_id: string; version_id: string; quote: string | null; confidence: number | null; extracted_by: string;
  valid_time: string | null; ingest_time: string; status: GraphClaim['status']; decided_by: string | null; decided_at: string | null;
};

/** Whether the caller may read a file, asked once per file per call. */
function readability(ctx: OperationContext) {
  const known = new Map<string, boolean>();
  return async (fileId: string): Promise<boolean> => {
    let ok = known.get(fileId);
    if (ok === undefined) {
      const live = ctx.sql.query<{ n: number }>("SELECT 1 AS n FROM drive_files WHERE id = ? AND state = 'live'", [fileId]).length > 0;
      ok = live && (await ctx.check(DRIVE_PERM.read, fileRef(fileId))).allowed;
      known.set(fileId, ok);
    }
    return ok;
  };
}

const entityOf = (row: EntityRow): GraphEntity => ({ id: row.id, type: row.type, name: row.name, status: row.status });

/** Claim rows as the UI reads them: names resolved, values displayed, what accepting would replace. */
function viewClaims(ctx: OperationContext, rows: readonly ClaimRow[]): GraphClaim[] {
  const entities = new Map<string, EntityRow>();
  const files = new Map<string, string | null>();
  const entity = (id: string) => {
    if (!entities.has(id)) {
      const row = ctx.sql.query<EntityRow>('SELECT * FROM graph_entities WHERE id = ?', [id])[0];
      if (row) entities.set(id, row);
    }
    return entities.get(id);
  };
  const fileName = (id: string) => {
    if (!files.has(id)) files.set(id, ctx.sql.query<{ name: string }>('SELECT name FROM drive_files WHERE id = ?', [id])[0]?.name ?? null);
    return files.get(id) ?? null;
  };
  const display = (kind: string, value: string) =>
    (kind === 'entity' ? value : normalizeValue(kind as ValueKind, value)?.display ?? value);
  const node = (kind: 'document' | 'entity', id: string): GraphNode | null => {
    if (kind === 'document') return { kind: 'document', fileId: id, name: fileName(id) ?? 'Deleted file' };
    const row = entity(id);
    return row ? { kind: 'entity', entity: entityOf(row) } : null;
  };
  const out: GraphClaim[] = [];
  for (const row of rows) {
    const subject = node(row.subject_type, row.subject_id);
    const object: GraphNode | null = row.object_entity_id
      ? node('entity', row.object_entity_id)
      : { kind: 'value', valueKind: row.object_kind as ValueKind, value: row.object_value!, display: display(row.object_kind, row.object_value!) };
    if (!subject || !object) continue;
    let replaces: string[] = [];
    if (row.status === 'suggested' && predicateById(row.predicate)?.cardinality === 'single') {
      replaces = ctx.sql.query<ClaimRow>(
        `SELECT * FROM graph_claims WHERE subject_type = ? AND subject_id = ? AND predicate = ? AND status = 'accepted'
           AND NOT (COALESCE(object_entity_id, '') = COALESCE(?, '') AND COALESCE(object_value, '') = COALESCE(?, ''))`,
        [row.subject_type, row.subject_id, row.predicate, row.object_entity_id, row.object_value],
      ).map((other) => (other.object_entity_id ? entity(other.object_entity_id)?.name ?? '' : display(other.object_kind, other.object_value!)))
        .filter(Boolean);
    }
    out.push({
      id: row.id, subject, predicate: row.predicate, object,
      fileId: row.file_id, fileName: fileName(row.file_id), versionId: row.version_id,
      quote: row.quote, confidence: row.confidence, extractedBy: row.extracted_by,
      validTime: row.valid_time, ingestTime: row.ingest_time,
      status: row.status, decidedBy: row.decided_by, decidedAt: row.decided_at, replaces,
    });
  }
  return out;
}

/** A file's claims worth showing: this version's open ones, and everything decided. */
function fileClaims(ctx: OperationContext, fileId: string): GraphClaim[] {
  const rows = ctx.sql.query<ClaimRow>(
    `SELECT * FROM graph_claims WHERE file_id = ? AND status <> 'superseded'
      ORDER BY CASE status WHEN 'suggested' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END, subject_type, subject_id, predicate, id`,
    [fileId],
  );
  return viewClaims(ctx, rows);
}

/** Suggested entities nothing refers to any more: a re-run replaced the claims that named them. */
function pruneEntities(ctx: OperationContext): void {
  ctx.sql.exec(`DELETE FROM graph_entities WHERE status = 'suggested'
    AND NOT EXISTS (SELECT 1 FROM graph_claims c WHERE c.subject_type = 'entity' AND c.subject_id = graph_entities.id)
    AND NOT EXISTS (SELECT 1 FROM graph_claims c WHERE c.object_entity_id = graph_entities.id)
    AND NOT EXISTS (SELECT 1 FROM graph_entities m WHERE m.merged_into = graph_entities.id)`);
}

type Ops = typeof driveOperations;
type GraphOp = 'drive/record-graph-suggestions' | 'drive/file-graph' | 'drive/decide-graph-claims' | 'drive/graph-suggestions' | 'drive/graph-entity';

export const graphHandlers = {
  'drive/record-graph-suggestions': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.write, fileRef(input.fileId)));
    const file = ctx.sql.query<{ state: string; current_version_id: string | null }>('SELECT state, current_version_id FROM drive_files WHERE id = ?', [input.fileId])[0];
    if (!file || file.state !== 'live') throw substratError('not_found', `file not found: ${input.fileId}`);
    if (file.current_version_id !== input.versionId) throw substratError('conflict', 'file content changed — these suggestions describe an older version');
    const now = ctx.now();

    // Open suggestions about an older version describe something else now; a re-run of this
    // version replaces its own. Decisions stay either way.
    ctx.sql.exec("UPDATE graph_claims SET status = 'superseded', decided_at = ? WHERE file_id = ? AND status = 'suggested' AND version_id <> ?",
      [now, input.fileId, input.versionId]);
    ctx.sql.exec("DELETE FROM graph_claims WHERE file_id = ? AND version_id = ? AND status = 'suggested'", [input.fileId, input.versionId]);

    let dropped = 0;
    // The entities, checked: a known type and a name that still says something once normalised.
    const extracted = new Map<string, { type: EntityType; name: string; key: string }>();
    for (const e of input.entities) {
      const name = e.name.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
      const key = isEntityType(e.type) ? nameKey(e.type, name) : '';
      if (!isEntityType(e.type) || !key || e.ref === DOCUMENT || extracted.has(e.ref)) { dropped++; continue; }
      extracted.set(e.ref, { type: e.type, name, key });
    }

    // The claims, checked against the vocabulary: subject and object of the right kinds, values
    // that normalise. Anything else is the model guessing, and a guess is dropped.
    type Valid = { subject: string; predicate: string; object: { ref: string } | { kind: ValueKind; value: string }; quote: string | null; confidence: number | null };
    const valid: Valid[] = [];
    for (const c of input.claims) {
      const predicate = predicateById(c.predicate);
      const subjectType: SubjectType | undefined = c.subject === DOCUMENT ? 'Document' : extracted.get(c.subject)?.type;
      if (!predicate || !subjectType || !allowsSubject(predicate, subjectType)) { dropped++; continue; }
      const quote = c.quote ? c.quote.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 400) || null : null;
      const confidence = typeof c.confidence === 'number' ? Math.min(1, Math.max(0, c.confidence)) : null;
      if ('ref' in c.object) {
        const target = extracted.get(c.object.ref);
        if (!target || c.object.ref === c.subject || !allowsObjectEntity(predicate, target.type)) { dropped++; continue; }
        valid.push({ subject: c.subject, predicate: predicate.id, object: { ref: c.object.ref }, quote, confidence });
      } else {
        const kind = 'value' in predicate.range ? predicate.range.value : null;
        const normal = kind ? normalizeValue(kind, c.object.value) : null;
        if (!kind || !normal) { dropped++; continue; }
        valid.push({ subject: c.subject, predicate: predicate.id, object: { kind, value: normal.value }, quote, confidence });
      }
    }

    // Identity: an extracted entity is an existing one when a match key agrees, else when its
    // normalised name does; otherwise it is new, and suggested until a statement about it is accepted.
    const resolved = new Map<string, string>();
    let created = 0;
    for (const [ref, e] of extracted) {
      let id: string | undefined;
      for (const c of valid) {
        if (c.subject !== ref || 'ref' in c.object || !predicateById(c.predicate)?.matchKey) continue;
        id = ctx.sql.query<{ id: string }>(
          `SELECT e.id FROM graph_claims c JOIN graph_entities e ON e.id = c.subject_id
            WHERE c.subject_type = 'entity' AND c.predicate = ? AND c.object_value = ? AND c.status IN ('suggested', 'accepted')
              AND e.type = ? AND e.merged_into IS NULL
            ORDER BY e.status = 'accepted' DESC, e.created_at LIMIT 1`,
          [c.predicate, c.object.value, e.type],
        )[0]?.id;
        if (id) break;
      }
      id ??= ctx.sql.query<{ id: string }>(
        `SELECT id FROM graph_entities WHERE type = ? AND name_key = ? AND merged_into IS NULL
          ORDER BY status = 'accepted' DESC, created_at LIMIT 1`, [e.type, e.key],
      )[0]?.id;
      if (!id) {
        id = ulid();
        ctx.sql.exec(`INSERT INTO graph_entities (id, type, name, name_key, status, merged_into, created_at, created_by)
          VALUES (?, ?, ?, ?, 'suggested', NULL, ?, ?)`, [id, e.type, e.name, e.key, now, ctx.principal]);
        created++;
      }
      resolved.set(ref, id);
    }

    // Every entity the document names is at least mentioned by it — the edge that says which
    // documents a person or company appears in — unless a claim already ties the two.
    const tied = new Set(valid.filter((c) => c.subject === DOCUMENT && 'ref' in c.object).map((c) => (c.object as { ref: string }).ref));
    for (const ref of resolved.keys()) {
      if (tied.has(ref)) continue;
      const about = valid.filter((c) => c.subject === ref || ('ref' in c.object && c.object.ref === ref));
      const confidence = about.reduce<number | null>((m, c) => (c.confidence == null ? m : Math.max(m ?? 0, c.confidence)), null);
      valid.push({ subject: DOCUMENT, predicate: 'mentions', object: { ref }, quote: null, confidence });
    }

    const validTime = input.validTime && normalizeValue('date', input.validTime)?.value || null;
    let suggested = 0, corroborated = 0;
    const seen = new Set<string>();
    for (const c of valid) {
      const subjectType = c.subject === DOCUMENT ? 'document' : 'entity';
      const subjectId = c.subject === DOCUMENT ? input.fileId : resolved.get(c.subject)!;
      const objectEntity = 'ref' in c.object ? resolved.get(c.object.ref)! : null;
      const objectKind = 'ref' in c.object ? 'entity' : c.object.kind;
      const objectValue = 'ref' in c.object ? null : c.object.value;
      if (objectEntity && objectEntity === subjectId) continue;
      const key = `${subjectType}|${subjectId}|${c.predicate}|${objectEntity ?? ''}|${objectValue ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const same = ctx.sql.query<{ status: string; file_id: string; version_id: string }>(
        `SELECT status, file_id, version_id FROM graph_claims
          WHERE subject_type = ? AND subject_id = ? AND predicate = ? AND COALESCE(object_entity_id, '') = ? AND COALESCE(object_value, '') = ?
            AND status IN ('accepted', 'rejected')`,
        [subjectType, subjectId, c.predicate, objectEntity ?? '', objectValue ?? ''],
      );
      // This version, already decided: a re-run asks nothing new.
      if (same.some((s) => s.file_id === input.fileId && s.version_id === input.versionId)) continue;
      const status = same.some((s) => s.status === 'accepted') ? 'accepted' : same.length ? 'rejected' : 'suggested';
      const decidedBy = status === 'accepted' ? 'auto:corroborates' : status === 'rejected' ? 'auto:rejected-before' : null;
      ctx.sql.exec(`INSERT INTO graph_claims (id, subject_type, subject_id, predicate, object_entity_id, object_kind, object_value,
          file_id, version_id, quote, confidence, extracted_by, valid_time, ingest_time, status, decided_by, decided_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ulid(), subjectType, subjectId, c.predicate, objectEntity, objectKind, objectValue,
        input.fileId, input.versionId, c.quote, c.confidence, input.extractedBy, validTime, now, status, decidedBy, decidedBy ? now : null]);
      if (status === 'suggested') suggested++;
      if (status === 'accepted') corroborated++;
    }
    pruneEntities(ctx);
    return { suggested, corroborated, dropped, entities: created };
  },

  'drive/file-graph': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.read, fileRef(input.fileId)));
    const file = ctx.sql.query<{ state: string }>('SELECT state FROM drive_files WHERE id = ?', [input.fileId])[0];
    if (!file || file.state !== 'live') throw substratError('not_found', `file not found: ${input.fileId}`);
    const canWrite = (await ctx.check(DRIVE_PERM.write, fileRef(input.fileId))).allowed;
    return { claims: fileClaims(ctx, input.fileId), canWrite };
  },

  'drive/decide-graph-claims': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.write, fileRef(input.fileId)));
    const file = ctx.sql.query<{ state: string }>('SELECT state FROM drive_files WHERE id = ?', [input.fileId])[0];
    if (!file || file.state !== 'live') throw substratError('not_found', `file not found: ${input.fileId}`);
    const now = ctx.now();
    let changed = 0;
    for (const claimId of new Set(input.claimIds)) {
      const row = ctx.sql.query<ClaimRow>('SELECT * FROM graph_claims WHERE id = ? AND file_id = ?', [claimId, input.fileId])[0];
      // A claim about a replaced version is history, not a question; one from another file is not this file's to decide.
      if (!row || row.status === 'superseded') continue;
      const target = input.decision === 'accept' ? 'accepted' : 'rejected';
      if (row.status === target) continue;
      ctx.sql.exec('UPDATE graph_claims SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?', [target, ctx.principal, now, claimId]);
      changed++;
      if (target !== 'accepted') continue;
      // A statement accepted about an entity makes the entity real.
      const ids = [row.subject_type === 'entity' ? row.subject_id : null, row.object_entity_id].filter((id): id is string => !!id);
      for (const id of ids) ctx.sql.exec("UPDATE graph_entities SET status = 'accepted' WHERE id = ? AND status = 'suggested'", [id]);
      // One value at a time: the accepted value it differs from becomes history.
      if (predicateById(row.predicate)?.cardinality === 'single') {
        ctx.sql.exec(`UPDATE graph_claims SET status = 'superseded', decided_by = ?, decided_at = ?
          WHERE subject_type = ? AND subject_id = ? AND predicate = ? AND status = 'accepted' AND id <> ?
            AND NOT (COALESCE(object_entity_id, '') = COALESCE(?, '') AND COALESCE(object_value, '') = COALESCE(?, ''))`,
        [ctx.principal, now, row.subject_type, row.subject_id, row.predicate, claimId, row.object_entity_id, row.object_value]);
      }
    }
    return { changed, claims: fileClaims(ctx, input.fileId) };
  },

  'drive/graph-suggestions': async (ctx, input) => {
    // The gate on ASKING; each claim is then gated by the file it was read from.
    assertAllowed(await ctx.check(DRIVE_PERM.read));
    const limit = input.limit ?? 50;
    const readable = readability(ctx);
    const out: ClaimRow[] = [];
    // Bounded, like search: a reader who can see none of it does O(1) work, not a walk of the space.
    const page = 200;
    for (let offset = 0; offset < 1000 && out.length < limit; offset += page) {
      const rows = ctx.sql.query<ClaimRow>(
        `SELECT c.* FROM graph_claims c JOIN drive_files f ON f.id = c.file_id
          WHERE c.status = 'suggested' AND f.state = 'live' AND f.current_version_id = c.version_id
          ORDER BY c.confidence IS NULL, c.confidence DESC, c.ingest_time DESC, c.id LIMIT ? OFFSET ?`,
        [page, offset],
      );
      for (const row of rows) {
        if (out.length === limit) break;
        if (await readable(row.file_id)) out.push(row);
      }
      if (rows.length < page) break;
    }
    return { claims: viewClaims(ctx, out) };
  },

  'drive/graph-entity': async (ctx, input) => {
    assertAllowed(await ctx.check(DRIVE_PERM.read));
    const readable = readability(ctx);
    let row = ctx.sql.query<EntityRow>('SELECT * FROM graph_entities WHERE id = ?', [input.entityId])[0];
    // A merged entity answers as the one it was merged into.
    for (let hops = 0; row?.merged_into && hops < 5; hops++) {
      row = ctx.sql.query<EntityRow>('SELECT * FROM graph_entities WHERE id = ?', [row.merged_into])[0];
    }
    const notFound = () => substratError('not_found', `entity not found: ${input.entityId}`);
    if (!row) throw notFound();
    const id = row.id;

    // What is said about it, or points at it, from documents the caller can read.
    const touching = (entityId: string, statuses: readonly string[]) => ctx.sql.query<ClaimRow>(
      `SELECT * FROM graph_claims WHERE ((subject_type = 'entity' AND subject_id = ?) OR object_entity_id = ?)
        AND status IN (${statuses.map(() => '?').join(', ')}) ORDER BY predicate, ingest_time DESC, id LIMIT 500`,
      [entityId, entityId, ...statuses],
    );
    const claims: ClaimRow[] = [];
    for (const c of touching(id, ['suggested', 'accepted'])) if (await readable(c.file_id)) claims.push(c);
    // An entity known only from documents the caller cannot read does not exist for them.
    if (!claims.length) throw notFound();

    // Connections over accepted claims only, documents counted as a hop — "issued by X, addressed to
    // Y" ties X to Y through the invoice. Walked here rather than in one recursive query because
    // every edge is gated by the file it came from, and that check is the kernel's, not SQL's.
    const maxDepth = input.depth ?? 2;
    const seenEntities = new Map<string, { depth: number; via: string[] }>([[id, { depth: 0, via: [] }]]);
    const seenDocs = new Set<string>();
    let frontier: { kind: 'entity' | 'document'; id: string; via: string[] }[] = [{ kind: 'entity', id, via: [] }];
    for (let depth = 1; depth <= maxDepth && frontier.length && seenEntities.size < 100; depth++) {
      const next: typeof frontier = [];
      for (const node of frontier) {
        const edges = node.kind === 'entity'
          ? touching(node.id, ['accepted'])
          : ctx.sql.query<ClaimRow>("SELECT * FROM graph_claims WHERE subject_type = 'document' AND subject_id = ? AND object_entity_id IS NOT NULL AND status = 'accepted'", [node.id]);
        for (const e of edges) {
          if (!(await readable(e.file_id))) continue;
          const candidates: { kind: 'entity' | 'document'; id: string }[] = [];
          if (e.subject_type === 'document') candidates.push({ kind: 'document', id: e.subject_id });
          else candidates.push({ kind: 'entity', id: e.subject_id });
          if (e.object_entity_id) candidates.push({ kind: 'entity', id: e.object_entity_id });
          for (const c of candidates) {
            if (c.kind === node.kind && c.id === node.id) continue;
            const via = [...node.via, e.predicate];
            if (c.kind === 'document') {
              if (seenDocs.has(c.id)) continue;
              seenDocs.add(c.id);
              next.push({ ...c, via });
            } else if (!seenEntities.has(c.id) && seenEntities.size < 100) {
              seenEntities.set(c.id, { depth, via });
              next.push({ ...c, via });
            }
          }
        }
      }
      frontier = next;
    }
    const connections = [...seenEntities.entries()]
      .filter(([eid]) => eid !== id)
      .map(([eid, { depth, via }]) => {
        const other = ctx.sql.query<EntityRow>('SELECT * FROM graph_entities WHERE id = ?', [eid])[0];
        return other ? { entity: entityOf(other), depth, via } : null;
      })
      .filter((c): c is NonNullable<typeof c> => !!c)
      .sort((a, b) => a.depth - b.depth || a.entity.name.localeCompare(b.entity.name));

    return { entity: entityOf(row), claims: viewClaims(ctx, claims), connections };
  },
} satisfies {
  [K in GraphOp]: OperationHandler<HandlerInput<Ops[K]>, HandlerOutput<Ops[K]>>;
};
