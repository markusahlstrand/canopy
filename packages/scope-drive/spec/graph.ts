/**
 * The knowledge graph's wire shapes: a claim as the review UI reads it, and the extraction
 * the worker hands the scope. The vocabulary they are checked against is `ontology.ts`.
 */
import { z } from '@substrat-run/contracts';
import { ENTITY_TYPES, VALUE_KINDS } from './ontology.js';

export const claimStatus = z.enum(['suggested', 'accepted', 'rejected', 'superseded']);
export type ClaimStatus = z.infer<typeof claimStatus>;

export const graphEntity = z.object({
  id: z.string(), type: z.enum(ENTITY_TYPES), name: z.string(), status: z.enum(['suggested', 'accepted']),
});
export type GraphEntity = z.infer<typeof graphEntity>;

/** What a claim is about, or points at: an entity, the document it was read from, or a value. */
export const graphNode = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('entity'), entity: graphEntity }),
  z.object({ kind: z.literal('document'), fileId: z.string(), name: z.string() }),
  z.object({ kind: z.literal('value'), valueKind: z.enum(VALUE_KINDS), value: z.string(), display: z.string() }),
]);
export type GraphNode = z.infer<typeof graphNode>;

export const graphClaim = z.object({
  id: z.string(),
  subject: graphNode,
  predicate: z.string(),
  object: graphNode,
  fileId: z.string(), fileName: z.string().nullable(), versionId: z.string(),
  quote: z.string().nullable(), confidence: z.number().nullable(), extractedBy: z.string(),
  validTime: z.string().nullable(), ingestTime: z.string(),
  status: claimStatus, decidedBy: z.string().nullable(), decidedAt: z.string().nullable(),
  /** For a one-value predicate: the accepted value(s) accepting this one would replace. */
  replaces: z.array(z.string()),
});
export type GraphClaim = z.infer<typeof graphClaim>;

/**
 * One model reading of one version, as the worker parsed it — loosely typed on purpose: the
 * scope checks every entity and claim against the vocabulary and drops what does not fit,
 * so a model answer can never put a predicate or value kind into the graph that is not there.
 */
export const graphExtraction = z.object({
  fileId: z.string(), versionId: z.string(),
  extractedBy: z.string().min(1).max(120),
  /** The document's own date: when what it says was true. */
  validTime: z.string().max(40).nullable().optional(),
  entities: z.array(z.object({ ref: z.string().min(1).max(40), type: z.string().max(40), name: z.string().max(300) })).max(60),
  claims: z.array(z.object({
    subject: z.string().min(1).max(40),
    predicate: z.string().min(1).max(60),
    object: z.union([z.object({ ref: z.string().min(1).max(40) }), z.object({ value: z.string().max(600) })]),
    quote: z.string().max(2000).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })).max(200),
});
export type GraphExtraction = z.infer<typeof graphExtraction>;

/** An entity reached from another, and how far away it is: documents count as a hop. */
export const graphConnection = z.object({ entity: graphEntity, depth: z.number().int(), via: z.array(z.string()) });

/** An entity as a list shows it: how many of the caller's readable documents it appears in. */
export const graphEntitySummary = z.object({ entity: graphEntity, documents: z.number().int() });
export type GraphEntitySummary = z.infer<typeof graphEntitySummary>;

/** What a merge did: the entity kept, how many went into it, and how many claims moved or settled. */
export const graphMergeResult = z.object({
  entity: graphEntity,
  merged: z.number().int(),
  /** Claims now about the kept entity that were about one of the merged ones. */
  moved: z.number().int(),
  /** Claims that became history: the same statement twice in one document, or one entity said to relate to itself. */
  superseded: z.number().int(),
});
export type GraphMergeResult = z.infer<typeof graphMergeResult>;
