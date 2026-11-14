/**
 * Flows: rules a space runs on the files that arrive in it — When → If → Then.
 *
 * A flow lives in its SOURCE space, beside the files it watches, so matching is a local
 * query. What it does elsewhere (a copy into another space) names that space by id and is
 * checked when the flow runs, as the person who saved it: a flow can never do anything its
 * author could not have done by hand.
 *
 * Shared by the drive module (which stores and validates), the worker (which matches and
 * runs) and the app (which edits). Pure data and pure functions only.
 */
import { z } from '@substrat-run/contracts';

/** A category id: stable across renames, so a flow that names one keeps matching. */
export const categoryId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Use lowercase letters, digits and dashes');

/** One category of a space's list: what Document AI may choose from. */
export const spaceCategory = z.object({
  id: categoryId,
  name: z.string().trim().min(1).max(60),
  /** What belongs here, in a sentence: it is what the model reads to decide. */
  hint: z.string().trim().max(200).optional(),
});
export type SpaceCategory = z.infer<typeof spaceCategory>;
export const spaceCategories = z.array(spaceCategory).max(30)
  .refine((list) => new Set(list.map((c) => c.id)).size === list.length, 'Each category needs its own id');

/** When a flow looks at a file. */
export const flowTrigger = z.discriminatedUnion('on', [
  /** A version arrived: uploaded, saved, synced from a connector, or mailed in. */
  z.object({ on: z.literal('arrived') }),
  /** Document AI (or a person) put the file in a category. */
  z.object({ on: z.literal('classified') }),
  /** On a timer, over the files that arrived since the last run. */
  z.object({ on: z.literal('schedule'), every: z.enum(['hour', 'day', 'week', 'month']) }),
]);
export type FlowTrigger = z.infer<typeof flowTrigger>;

const folderPath = z.string().max(1000).transform((p) => p.split('/').map((s) => s.trim()).filter(Boolean).join('/'));

/** What a file must be for a flow to act on it. Every condition must hold. */
export const flowCondition = z.discriminatedUnion('field', [
  /** In this folder, or (`under`) anywhere beneath it. '' is the space's root. */
  z.object({ field: z.literal('folder'), op: z.enum(['is', 'under']), path: folderPath }),
  /** The file name contains this text (any case), or matches a `*`/`?` pattern. */
  z.object({ field: z.literal('name'), op: z.enum(['contains', 'matches']), value: z.string().trim().min(1).max(200) }),
  /** The extension, without the dot, is one of these (any case). */
  z.object({ field: z.literal('extension'), values: z.array(z.string().trim().min(1).max(20)).min(1).max(20) }),
  /** The category is one of these, at or above a confidence (a person's choice always counts). */
  z.object({ field: z.literal('category'), values: z.array(categoryId).min(1).max(30), minConfidence: z.number().min(0).max(1).default(0.7) }),
  /** One of the file's labels is this (any case). */
  z.object({ field: z.literal('label'), value: z.string().trim().min(1).max(100) }),
  /** Ask the model a yes/no question about the document; answered once per version. */
  z.object({ field: z.literal('ask'), question: z.string().trim().min(3).max(300) }),
]);
export type FlowCondition = z.infer<typeof flowCondition>;

/** What a flow does to a file that matches. */
export const flowAction = z.discriminatedUnion('type', [
  /**
   * Copy the file into a folder of another space (or this one). In a space connected to a
   * source that takes uploads (a3doc, S3), the copy goes on to the source like any upload;
   * `alsoIn` files an a3doc document in more categories (folder ids of that space).
   */
  z.object({
    type: z.literal('copy'),
    space: z.string().min(1).max(64),
    folderId: z.string().min(1).max(64),
    alsoIn: z.array(z.string().min(1)).max(10).default([]),
  }),
  /** Add a label to the file here. */
  z.object({ type: z.literal('label'), value: z.string().trim().min(1).max(100) }),
]);
export type FlowAction = z.infer<typeof flowAction>;

export const flowDefinition = z.object({
  trigger: flowTrigger,
  conditions: z.array(flowCondition).max(10).default([]),
  actions: z.array(flowAction).min(1).max(5),
  /** `auto` acts at once; `ask` proposes each match, to approve or dismiss. */
  mode: z.enum(['auto', 'ask']).default('ask'),
  /** `first`: act on a file once. `every`: again for each new version. */
  versions: z.enum(['first', 'every']).default('first'),
});
export type FlowDefinition = z.infer<typeof flowDefinition>;

/** A flow as the app reads it. */
export const storedFlow = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  definition: flowDefinition,
  author: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastRunAt: z.string().nullable(),
  failures: z.number().int(),
  pausedReason: z.string().nullable(),
});
export type StoredFlow = z.infer<typeof storedFlow>;

export const deliveryState = z.enum(['proposed', 'approved', 'running', 'done', 'failed', 'dismissed', 'skipped']);
export type DeliveryState = z.infer<typeof deliveryState>;

/** What a flow did to one version of one file. */
export const flowDelivery = z.object({
  flowId: z.string(),
  fileId: z.string(),
  versionId: z.string(),
  fileName: z.string().nullable(),
  state: deliveryState,
  /** Where copies went (`targets`), or why it failed or was skipped (`error`, `reason`). */
  detail: z.record(z.string(), z.unknown()),
  attempts: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FlowDelivery = z.infer<typeof flowDelivery>;

/** What a condition is checked against: the file as the source space sees it now. */
export interface FileFacts {
  name: string;
  folderPath: string;
  labels: readonly string[];
  category: { id: string | null; confidence: number | null; source: 'ai' | 'person' } | null;
}

/**
 * `*` any run, `?` one character; everything else literal. Whole-name, any case. A greedy matcher
 * that backtracks only to the last `*`, so it runs in time linear-times-pattern, never exponential.
 */
export function globMatches(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase(), n = name.toLowerCase();
  let i = 0, j = 0, star = -1, mark = 0;
  while (j < n.length) {
    if (i < p.length && (p[i] === '?' || (p[i] !== '*' && p[i] === n[j]))) { i++; j++; }
    else if (i < p.length && p[i] === '*') { star = i++; mark = j; }
    else if (star >= 0) { i = star + 1; j = ++mark; }
    else return false;
  }
  while (p[i] === '*') i++;
  return i === p.length;
}

export const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/**
 * Whether one condition holds — or `'ask'` for a model question, which only the runner can
 * answer. Pure, so the app can preview a flow against files with the same code that runs it.
 */
export function conditionHolds(condition: FlowCondition, facts: FileFacts): boolean | 'ask' {
  switch (condition.field) {
    case 'folder':
      return condition.op === 'is'
        ? facts.folderPath === condition.path
        : condition.path === '' || facts.folderPath === condition.path || facts.folderPath.startsWith(`${condition.path}/`);
    case 'name':
      return condition.op === 'contains'
        ? facts.name.toLowerCase().includes(condition.value.toLowerCase())
        : globMatches(condition.value, facts.name);
    case 'extension':
      return condition.values.map((v) => v.replace(/^\./, '').toLowerCase()).includes(extensionOf(facts.name));
    case 'category': {
      const c = facts.category;
      if (!c?.id || !condition.values.includes(c.id)) return false;
      return c.source === 'person' || (c.confidence ?? 0) >= condition.minConfidence;
    }
    case 'label':
      return facts.labels.some((l) => l.toLowerCase() === condition.value.toLowerCase());
    case 'ask':
      return 'ask';
  }
}

/**
 * Whether a flow matches, without model questions: `false` as soon as one plain condition
 * fails, else `true`, or `'ask'` when the rest hinges on questions only the runner asks.
 */
export function flowMatches(definition: Pick<FlowDefinition, 'conditions'>, facts: FileFacts): boolean | 'ask' {
  let ask = false;
  for (const condition of definition.conditions) {
    const held = conditionHolds(condition, facts);
    if (held === false) return false;
    if (held === 'ask') ask = true;
  }
  return ask ? 'ask' : true;
}

/** Whether a trigger reacts to a queued arrival or classification. */
export function triggerReacts(trigger: FlowTrigger, event: 'arrived' | 'classified'): boolean {
  return trigger.on === event;
}

const PERIOD_MS = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 } as const;

/** Whether a scheduled flow is due at `now`, given when it last ran (never ⇒ due). */
export function scheduleDue(trigger: FlowTrigger, lastRunAt: string | null, now: number): boolean {
  if (trigger.on !== 'schedule') return false;
  if (!lastRunAt) return true;
  return now - Date.parse(lastRunAt) >= PERIOD_MS[trigger.every];
}
