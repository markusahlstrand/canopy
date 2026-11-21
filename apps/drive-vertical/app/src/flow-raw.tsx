/**
 * One flow as JSON: what it is stored as, to read, paste or change by hand. Only what a person
 * owns is in the text (its name, whether it is on, and its graph); the id, the author and the
 * timestamps are Canopy's, so they are left out and anything like them is ignored.
 *
 * The text is checked with the very schema the save route uses (`flowSaveInput`), so what this
 * accepts the server accepts, short of what only the server can tell (who owns which space).
 */
import { Button } from '@canopy/ui';
import type { z } from '@substrat-run/contracts';
import { flowGraphShape } from '@canopy/scope-drive/spec/model';
import { flowSaveInput } from '../../src/flow-contract';
import type { Draft } from './flow-editor';

/** The fields a person edits. Everything else on a stored flow is the server's. */
const EDITABLE = ['name', 'enabled', 'graph'] as const;

/**
 * The same input, with what the canvas can show left to it: a graph that can't run yet is drawn
 * there with what still needs doing. Steps must still have ids of their own, since the canvas
 * finds and changes a step by its id. Blank fields are allowed too (see `readDraft`).
 */
const canvasInput = flowSaveInput.extend({
  graph: flowGraphShape.superRefine((graph, ctx) => {
    const seen = new Set<string>();
    graph.nodes.forEach((node, i) => {
      if (seen.has(node.id)) ctx.addIssue({ code: 'custom', message: `Two steps share the id '${node.id}'.`, path: ['nodes', i, 'id'] });
      seen.add(node.id);
    });
  }),
});

type Issue = z.core.$ZodIssue;
type Path = readonly PropertyKey[];

/** A field the editor leaves empty until it is filled in: a blank name, label or space, an empty list. */
const unfinished = (issue: Issue): issue is Extract<Issue, { code: 'too_small' }> =>
  issue.code === 'too_small' && (issue.origin === 'string' || issue.origin === 'array');

const at = (value: unknown, path: Path): unknown =>
  path.reduce<unknown>((v, key) => (v && typeof v === 'object' ? (v as Record<PropertyKey, unknown>)[key] : undefined), value);
function put(value: unknown, path: Path, next: unknown) {
  const parent = at(value, path.slice(0, -1));
  if (parent && typeof parent === 'object') (parent as Record<PropertyKey, unknown>)[path[path.length - 1]!] = next;
}

/**
 * Check for the canvas: like saving, but blank fields pass. Each blank is stood in for just long
 * enough for the schema to fill in defaults, then put back as it was, so the canvas shows it as a
 * step still to finish. Anything else wrong stays wrong.
 */
function parseForCanvas(input: Record<string, unknown>) {
  const first = canvasInput.safeParse(input);
  if (first.success || !first.error.issues.every(unfinished)) return first;
  const blanks = first.error.issues.map((issue) => ({ path: issue.path, value: at(input, issue.path), min: Number(issue.minimum) }));
  const filled = structuredClone(input);
  for (const b of blanks) put(filled, b.path, Array.isArray(b.value) ? Array.from({ length: b.min }, (_, i) => `x${i}`) : 'x'.repeat(b.min));
  const second = canvasInput.safeParse(filled);
  if (!second.success) return first;
  for (const b of blanks) put(second.data, b.path, b.value);
  return second;
}

/** How many problems the text shows at once. */
const MAX_ISSUES = 6;

export const draftJson = (draft: Draft): string =>
  JSON.stringify({ name: draft.name, enabled: draft.enabled, graph: draft.graph }, null, 2);

export type RawRead =
  | { ok: true; draft: Draft; ignored: string[] }
  | { ok: false; problems: string[] };

/**
 * The draft the text describes, keeping the flow's own id whatever the text says. `save` checks
 * it as the server will; `canvas` only that the canvas can draw it.
 */
export function readDraft(text: string, id: string | undefined, purpose: 'save' | 'canvas'): RawRead {
  let value: unknown;
  try { value = JSON.parse(text); } catch (e) {
    return { ok: false, problems: [`This isn’t valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, problems: ['A flow is a JSON object with a name, enabled and a graph.'] };
  }
  const record = value as Record<string, unknown>;
  const ignored = Object.keys(record).filter((k) => !(EDITABLE as readonly string[]).includes(k));
  const editable = Object.fromEntries(EDITABLE.filter((k) => k in record).map((k) => [k, record[k]]));
  const parsed = purpose === 'save' ? flowSaveInput.safeParse(editable) : parseForCanvas(editable);
  if (!parsed.success) {
    const problems = parsed.error.issues.slice(0, MAX_ISSUES).map((issue) => {
      const where = issue.path.map(String).join(' › ');
      return where ? `${where}: ${issue.message}` : issue.message;
    });
    const more = parsed.error.issues.length - problems.length;
    return { ok: false, problems: more > 0 ? [...problems, `…and ${more} more.`] : problems };
  }
  const { name, enabled, graph } = parsed.data;
  return { ok: true, draft: { ...(id ? { id } : {}), name, enabled, graph }, ignored };
}

/** What the raw view says under the text: what is wrong with it, or what it did. */
export type RawStatus = { kind: 'problems'; problems: string[] } | { kind: 'note'; text: string } | null;

export function FlowRawEditor({ id, text, status, busy, onChange, onCheck, onReset }: {
  id?: string; text: string; status: RawStatus; busy: boolean;
  onChange: (text: string) => void; onCheck: () => void; onReset: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 text-sm">
      <p className="text-xs text-muted-foreground">
        The flow as it is stored: its name, whether it is on, and its steps and connections.{' '}
        {id ? <>Its id (<code className="font-mono">{id}</code>), who saved it and when are kept by Canopy and can’t be changed here.</>
          : 'Canopy gives it an id, an author and timestamps when you save it.'}
      </p>
      <textarea aria-label="Flow as JSON" value={text} disabled={busy} spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off"
        aria-invalid={status?.kind === 'problems'} aria-describedby={status ? 'flow-raw-status' : undefined}
        className="min-h-[320px] w-full flex-1 resize-none rounded-md border bg-background p-3 font-mono text-base leading-relaxed shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive disabled:opacity-50 md:text-xs"
        onChange={(e) => onChange(e.target.value)} />
      {status?.kind === 'problems' ? (
        <section id="flow-raw-status" role="alert" aria-label="What is wrong with the JSON" className="space-y-1 rounded-lg border border-destructive/40 p-3">
          <h3 className="text-xs font-medium text-destructive">This can’t be saved yet</h3>
          <ul className="list-disc space-y-0.5 pl-4 font-mono text-xs break-words">{status.problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </section>
      ) : status ? <p id="flow-raw-status" role="status" className="text-xs text-muted-foreground">{status.text}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onCheck}>Check</Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onReset}>Undo my changes</Button>
      </div>
    </div>
  );
}
