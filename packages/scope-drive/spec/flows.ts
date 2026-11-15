/**
 * The parts flows are made of: categories, conditions and actions, and what a flow did to a file.
 * Flows themselves are graphs (`flow-graph.ts`) kept by the install, not by a space.
 *
 * A flow acts as the person who saved it last: it can never do anything its author could not
 * have done by hand.
 *
 * `legacyFlowDefinition` is the shape flows had while each lived in its space (`drive_flows`);
 * the runner reads such rows once, turns them into graphs and moves them out.
 *
 * Shared by the drive module, the worker and the app. Pure data and pure functions only.
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

/** When a space-local flow looked at a file. */
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
  /**
   * In this folder, or (`under`) anywhere beneath it. '' is the space's root. `matches` is a
   * pattern for the whole path, a level at a time: a level is a name, `*` (any one folder), or a
   * `{name}` that takes the folder's name for later steps to use (`Client invoices/{year}/{month}`).
   */
  z.object({ field: z.literal('folder'), op: z.enum(['is', 'under', 'matches']), path: folderPath }),
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

/**
 * Copy the file into a folder of a space. In a space connected to a source that takes uploads
 * (a3doc, S3), the copy goes on to the source like any upload; `alsoIn` files an a3doc document
 * in more categories (folder ids of that space).
 *
 * `subfolder` goes on below the chosen folder, and `alsoInPaths` names more categories by their
 * path from the top of the space. Both may hold `{name}`s a folder pattern took earlier on the
 * way, so one flow files each document by its own year and month. A folder they name that is
 * not there yet is made: in an a3doc space it is made here and taken up by a3doc's own folder
 * when the document is filed there (a3doc refuses a folder it does not have).
 */
export const copyFields = {
  space: z.string().min(1).max(64),
  folderId: z.string().min(1).max(64),
  alsoIn: z.array(z.string().min(1)).max(10).default([]),
  subfolder: z.string().max(500).optional(),
  alsoInPaths: z.array(z.string().max(500)).max(10).optional(),
};

/** At most this many categories besides the folder itself, picked and typed together. */
export const MAX_ALSO_IN = 10;

// ── folder patterns and path templates ──────────────────────────────────────

/** A `{name}` a pattern takes and a template uses. */
const TOKEN = /\{([^{}]*)\}/g;
export const TOKEN_NAME = /^[a-z][a-z0-9_]{0,19}$/;

/** The `{name}`s in a pattern or template, in order, each once. */
export function tokensOf(text: string): string[] {
  return [...new Set([...text.matchAll(TOKEN)].map((m) => m[1]!))];
}

/** What is wrong with a folder pattern, in words; null when it is fine. */
export function patternProblem(pattern: string): string | null {
  const taken = new Set<string>();
  for (const level of pattern.split('/').filter(Boolean)) {
    const whole = /^\{([^{}]*)\}$/.exec(level);
    if (!whole) {
      if (/[{}]/.test(level)) return `A {name} takes a whole folder level: '${level}' mixes it with text.`;
      continue;
    }
    const name = whole[1]!;
    if (!TOKEN_NAME.test(name)) return `'{${name}}' needs a short lowercase name, like {year}.`;
    if (taken.has(name)) return `'{${name}}' is taken twice.`;
    taken.add(name);
  }
  return null;
}

/** What is wrong with a path template, in words; null when it is fine. */
export function templateProblem(template: string): string | null {
  if (/[{}]/.test(template.replace(TOKEN, ''))) return `'${template}' has a { or } without its pair.`;
  for (const name of tokensOf(template)) if (!TOKEN_NAME.test(name)) return `'{${name}}' needs a short lowercase name, like {year}.`;
  for (const level of template.split('/').map((s) => s.trim())) if (level === '.' || level === '..') return `'${template}' can't use . or .. as a folder.`;
  return null;
}

/**
 * The names a folder pattern takes from a folder path, or null when the path doesn't fit it.
 * Every level must fit: the pattern says how deep the folder is. Names compare as `is` does.
 */
export function folderCaptures(pattern: string, folderPath: string): Record<string, string> | null {
  const want = pattern.split('/').filter(Boolean), have = folderPath.split('/').filter(Boolean);
  if (want.length !== have.length) return null;
  const captures: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const level = want[i]!, name = /^\{([a-z][a-z0-9_]{0,19})\}$/.exec(level)?.[1];
    if (name) captures[name] = have[i]!;
    else if (level !== '*' && level !== have[i]) return null;
  }
  return captures;
}

/**
 * A template with its `{name}`s filled in, as a clean path ('' for the folder itself). Throws,
 * naming the first, when a name has no value: the flow can't say where the document goes.
 */
export function fillTemplate(template: string, captures: Readonly<Record<string, string>>): string {
  const missing = tokensOf(template).find((name) => captures[name] === undefined);
  if (missing !== undefined) throw new Error(`nothing on this document's way took {${missing}}`);
  const filled = template.replace(TOKEN, (_, name: string) => captures[name]!);
  const levels = filled.split('/').map((s) => s.trim()).filter(Boolean);
  if (levels.some((l) => l === '.' || l === '..')) throw new Error(`'${filled}' is not a folder path`);
  return levels.join('/');
}

/** What a space-local flow did to a file that matched. */
export const flowAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('copy'), ...copyFields }),
  /** Add a label to the file here. */
  z.object({ type: z.literal('label'), value: z.string().trim().min(1).max(100) }),
]);
export type FlowAction = z.infer<typeof flowAction>;

export const legacyFlowDefinition = z.object({
  trigger: flowTrigger,
  conditions: z.array(flowCondition).max(10).default([]),
  actions: z.array(flowAction).min(1).max(5),
  /** `auto` acts at once; `ask` proposes each match, to approve or dismiss. */
  mode: z.enum(['auto', 'ask']).default('ask'),
  /** `first`: act on a file once. `every`: again for each new version. */
  versions: z.enum(['first', 'every']).default('first'),
});
export type LegacyFlowDefinition = z.infer<typeof legacyFlowDefinition>;

/** A space-local flow row, as the runner reads it to move it out. Its definition is checked there. */
export const legacyFlow = z.object({
  id: z.string(), name: z.string(), enabled: z.boolean(), definition: z.unknown(), author: z.string(), authorSub: z.string(),
  createdAt: z.string(), updatedAt: z.string(), lastRunAt: z.string().nullable(), failures: z.number().int(), pausedReason: z.string().nullable(),
});
export type LegacyFlow = z.infer<typeof legacyFlow>;

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
      if (condition.op === 'matches') return folderCaptures(condition.path, facts.folderPath) !== null;
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
