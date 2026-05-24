import type { AiContentPart, AiGateway, AiMessage, ConnectorConfigField } from "@canopy/core";

/**
 * Server-side **document processors** — trusted code that runs when a file is
 * added and returns metadata to merge into it (type labels, a description). This
 * is the "server-side processor" shape (a future `enrichItem` / `transformUpload`
 * plugin hook); until the sandbox runtime exists it runs first-party in the API,
 * exactly like a data source. Inference is not the processor's concern: it asks the
 * host's AI gateway (handed in via `ctx`) for a model and a completion, so the same
 * processor runs on Cloudflare Workers AI, Gemini, or a local model unchanged.
 */
export interface ProcessorFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

/** Host capabilities handed to a processor when it runs. */
export interface ProcessorContext {
  /** The deployment's AI gateway, if any provider is configured. */
  ai?: AiGateway;
}

/** What a processor produces for one file. */
export interface ProcessorResult {
  /** Type labels to merge into metadata.labels. */
  labels: string[];
  /** A generated description for metadata.description (only set if absent). */
  description?: string;
  /** Identifier of the model/engine used, for the processing log. */
  model?: string;
  /** Set when the run failed; recorded in the processing log, never thrown. */
  error?: string;
}

/**
 * One entry in a file's processing log (`metadata.processing`), written each time
 * a processor runs over the file. Lets a user see whether — and how — the file was
 * processed. Newest entries are appended; the UI shows them newest-first.
 */
export interface ProcessingEntry {
  /** ISO timestamp of the run. */
  at: string;
  /** Processor id (e.g. "document-ai"). */
  plugin: string;
  status: "ok" | "error";
  /** Model/engine used, when known. */
  model?: string;
  /** Labels produced by this run. */
  labels?: string[];
  /** Whether this run wrote a description. */
  described?: boolean;
  /** Error message (status "error") or other note. */
  note?: string;
}

export interface DocumentProcessor {
  id: string;
  configFields: ConnectorConfigField[];
  /**
   * Whether this processor should run for the given user config + host context.
   * Defaults (when omitted) to "all required config fields are present". Document
   * AI overrides it to "an AI provider exists", so it works with zero per-user
   * config wherever the host exposes a model (e.g. Workers AI on Cloudflare).
   */
  eligible?(config: Record<string, string>, ctx: ProcessorContext): boolean;
  /** Analyze a freshly-added file and return labels / description to merge. */
  process(file: ProcessorFile, config: Record<string, string>, ctx: ProcessorContext): Promise<ProcessorResult>;
}

// ── Document AI: classify + describe each added document via the host AI gateway ──

const DEFAULT_LANGUAGE = "English";
const MAX_TEXT_CHARS = 12_000;
const MAX_INLINE_BYTES = 4 * 1024 * 1024; // ~4 MB before base64

const TEXTUAL = /^(text\/|application\/(json|xml|x-yaml|yaml))/i;
const INLINE_OK = /^(application\/pdf|image\/(png|jpe?g|webp|gif|heic))/i;

function analyzePrompt(language: string): string {
  return (
    "You are a document analyzer. Read the document and return a JSON object with two fields:\n" +
    '- "label": a concise document-type label of 1-3 words ' +
    "(examples: Invoice, Receipt, Contract, Lease, Bank statement, Tax form, Resume, Letter, Report, Manual, Presentation, Photo).\n" +
    '- "description": one or two sentences summarizing what this specific document is and its key details ' +
    "(such as who it is from, what it concerns, and any amount or date present).\n" +
    `Write the values of both "label" and "description" in ${language}. ` +
    "Return ONLY the JSON object, with no markdown fences or extra text."
  );
}

/** Build the analyzer messages, attaching the file's bytes the model can actually read. */
function analyzeMessages(file: ProcessorFile, language: string, vision: boolean): AiMessage[] {
  const mime = (file.mime || "").toLowerCase();
  const parts: AiContentPart[] = [{ kind: "text", text: `Filename: ${file.name}` }];
  if (TEXTUAL.test(mime)) {
    const text = new TextDecoder().decode(file.bytes).slice(0, MAX_TEXT_CHARS);
    if (text.trim()) parts.push({ kind: "text", text: `\nDocument:\n${text}` });
  } else if (vision && INLINE_OK.test(mime) && file.bytes.byteLength <= MAX_INLINE_BYTES) {
    parts.push({ kind: "image", mime, bytes: file.bytes });
  }
  // else: nothing feedable (huge/opaque binary, or a non-vision model) — analyze by name only.
  return [
    { role: "system", content: analyzePrompt(language) },
    { role: "user", content: parts },
  ];
}

/** Pull `{ label, description }` out of the model's JSON reply, tolerating stray fences. */
function parseAnalysis(raw: string): { label: string | null; description: string | null } | null {
  const json = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  let obj: { label?: unknown; description?: unknown };
  try {
    obj = JSON.parse(json) as typeof obj;
  } catch {
    return null;
  }
  const label = typeof obj.label === "string" ? obj.label.replace(/^["'\s.]+|["'\s.]+$/g, "").slice(0, 40) : "";
  const description = typeof obj.description === "string" ? obj.description.trim().slice(0, 600) : "";
  return { label: label || null, description: description || null };
}

/**
 * Classifies and describes each added document. The model is whichever one the user
 * picked in settings (or the first the host exposes — Gemma on Cloudflare); inference
 * runs through the host AI gateway, never a key held here.
 */
export const documentAiProcessor: DocumentProcessor = {
  id: "document-ai",
  configFields: [
    // `model` options are filled by the host from the AI gateway (see app.ts).
    { key: "model", label: "Model", type: "select", optionsFrom: "ai-models" },
    { key: "language", label: "Output language (default: English)", type: "string" },
  ],
  eligible: (_config, ctx) => !!ctx.ai && ctx.ai.models().length > 0,
  async process(file, config, ctx) {
    if (!ctx.ai) return { labels: [], error: "no AI provider configured on this server" };
    // The user's choice, else the first model the host exposes (zero-config default).
    const model = config.model?.trim() || ctx.ai.models()[0]?.id;
    if (!model) return { labels: [], error: "no AI model available" };
    const vision = ctx.ai.models().find((m) => m.id === model)?.vision ?? false;
    const language = config.language?.trim() || DEFAULT_LANGUAGE;
    try {
      const out = await ctx.ai.generate({
        model,
        messages: analyzeMessages(file, language, vision),
        temperature: 0,
        maxTokens: 512,
        json: true,
      });
      const parsed = parseAnalysis(out.text);
      if (!parsed) return { labels: [], model: out.model, error: "unparseable model output" };
      return {
        labels: parsed.label ? [parsed.label] : [],
        description: parsed.description ?? undefined,
        model: out.model,
      };
    } catch (err) {
      return { labels: [], model, error: (err as Error).message };
    }
  },
};

export const PROCESSORS: DocumentProcessor[] = [documentAiProcessor];
