/**
 * Document AI: after an upload's text is indexed, ask a model what kind of document it
 * is and fill in the file's label and description — the processor the retired portal
 * ran, moved onto the vertical's own seams.
 *
 * Three rules keep it a helper and not an author:
 *
 *  - **opt-in per space** (`autoLabel` in space settings): it sends document text to a
 *    model, which is a decision an administrator makes, not a default;
 *  - **fills only what is empty**: a description a person wrote is never replaced, and
 *    the label is added beside theirs, not over them;
 *  - **reads the kernel's extraction**, never the bytes: what search can read is what the
 *    model reads, so a scan with no text layer is skipped rather than guessed from its name.
 *
 * The model call runs here, in the worker, and never inside an operation: a scope
 * transaction must not span a multi-second round trip (D-59).
 */
import { errorCodeOf } from '@substrat-run/contracts';
import type { ModelHost, ModelAttribution } from '@substrat-run/vertical-host/model';

/** Cheap, fast, and reliable at a two-field JSON answer. `DOCUMENT_AI_MODEL` overrides it. */
export const DEFAULT_DOCUMENT_AI_MODEL = 'cloudflare:@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const MAX_TEXT_CHARS = 12_000;

const SYSTEM =
  'You are a document analyzer. Read the document and return a JSON object with two fields:\n' +
  '- "label": a concise document-type label of 1-3 words ' +
  '(examples: Invoice, Receipt, Contract, Lease, Bank statement, Tax form, Resume, Letter, Report, Manual, Presentation).\n' +
  '- "description": one or two sentences summarizing what this specific document is and its key details ' +
  '(such as who it is from, what it concerns, and any amount or date present).\n' +
  'Write both values in English. Return ONLY the JSON object, with no markdown fences or extra text.';

/** Pull `{ label, description }` out of the model's reply, tolerating fences and chatter around it. */
export function parseAnalysis(raw: string): { label: string | null; description: string | null } | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj: { label?: unknown; description?: unknown };
  try {
    obj = JSON.parse(raw.slice(start, end + 1)) as typeof obj;
  } catch {
    return null;
  }
  const label = typeof obj.label === 'string' ? obj.label.replace(/^["'\s.]+|["'\s.]+$/g, '').slice(0, 40) : '';
  const description = typeof obj.description === 'string' ? obj.description.trim().slice(0, 600) : '';
  return { label: label || null, description: description || null };
}

interface Details { description: string; labels: string[]; revision: number; canWrite: boolean }

/** The scope reads and the one write this needs, as the uploader. */
export interface AutoLabelScope {
  invoke<T>(operation: string, input: Record<string, unknown>): Promise<T>;
}

export type AutoLabelOutcome =
  | { status: 'labelled'; label: string | null; described: boolean }
  | { status: 'skipped'; reason: 'already-described' | 'read-only' | 'no-text' | 'nothing-new' | 'edited-meanwhile' | 'unparseable' };

/**
 * Label one file. Every early return is a reason, so the log says why a file was left
 * alone; a model or scope failure throws, and the caller logs it.
 */
export async function autoLabel(
  scope: AutoLabelScope,
  file: { id: string; name: string },
  model: { host: ModelHost; spec: string; attribution: ModelAttribution },
): Promise<AutoLabelOutcome> {
  const before = await scope.invoke<Details>('drive/file-details', { fileId: file.id });
  if (!before.canWrite) return { status: 'skipped', reason: 'read-only' };
  // Both halves already there: nothing to fill, so nothing to pay a model for.
  if (before.description.trim() && before.labels.length) return { status: 'skipped', reason: 'already-described' };

  const excerpt = await scope.invoke<{ text: string } | null>('drive/file-text-excerpt', { fileId: file.id, maxChars: MAX_TEXT_CHARS });
  if (!excerpt?.text.trim()) return { status: 'skipped', reason: 'no-text' };

  const run = await model.host.run({
    spec: model.spec,
    attribution: model.attribution,
    system: SYSTEM,
    prompt: `Filename: ${file.name}\n\nDocument:\n${excerpt.text}`,
    temperature: 0,
    maxOutputTokens: 400,
  });
  const analysis = parseAnalysis(run.text);
  if (!analysis) return { status: 'skipped', reason: 'unparseable' };

  const label = analysis.label && !before.labels.some((l) => l.toLowerCase() === analysis.label!.toLowerCase())
    ? analysis.label : null;
  const description = before.description.trim() ? before.description : analysis.description ?? before.description;
  const described = description !== before.description;
  if (!label && !described) return { status: 'skipped', reason: 'nothing-new' };

  try {
    await scope.invoke('drive/update-file-details', {
      fileId: file.id,
      description,
      labels: label ? [...before.labels, label].slice(0, 20) : before.labels,
      // The revision read before the model ran: a person who saved meanwhile wins.
      expectedRevision: before.revision,
    });
  } catch (error) {
    if (errorCodeOf(error) === 'conflict') return { status: 'skipped', reason: 'edited-meanwhile' };
    throw error;
  }
  return { status: 'labelled', label, described };
}
