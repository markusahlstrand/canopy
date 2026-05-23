/**
 * Minimal Google Gemini ("Flash") client for analyzing a document. One call
 * returns both a short type label (Invoice, Receipt…) and a one/two-sentence
 * description of the specific document, written in a configurable language.
 * Multimodal: text-ish files are sent as text; PDFs/images are sent as inline
 * base64 so Flash reads them directly. Never throws — failures come back as an
 * `error` on the result so the caller can log them; analysis must not break an
 * upload.
 */

const DEFAULT_MODEL = "gemini-3.5-flash";
const DEFAULT_LANGUAGE = "English";
const MAX_TEXT_CHARS = 12_000;
const MAX_INLINE_BYTES = 4 * 1024 * 1024; // ~4 MB before base64

const TEXTUAL = /^(text\/|application\/(json|xml|x-yaml|yaml))/i;
const INLINE_OK = /^(application\/pdf|image\/(png|jpe?g|webp|gif|heic))/i;

function prompt(language: string): string {
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

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

export interface AnalyzeInput {
  apiKey: string;
  model?: string;
  /** Output language for the label and description (default: English). */
  language?: string;
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface AnalyzeResult {
  /** Short type label (1-3 words), or null if none could be produced. */
  label: string | null;
  /** One/two-sentence summary of the document, or null if none. */
  description: string | null;
  /** The model actually used (for the processing log). */
  model: string;
  /** Set when the call failed; a short message for the processing log. */
  error?: string;
}

/** Analyze a document into a type label + description. Never throws. */
export async function analyzeDocument(input: AnalyzeInput): Promise<AnalyzeResult> {
  const model = input.model?.trim() || DEFAULT_MODEL;
  const language = input.language?.trim() || DEFAULT_LANGUAGE;
  const mime = (input.mime || "").toLowerCase();
  const parts: Record<string, unknown>[] = [{ text: `${prompt(language)}\nFilename: ${input.name}` }];

  if (TEXTUAL.test(mime)) {
    const text = new TextDecoder().decode(input.bytes).slice(0, MAX_TEXT_CHARS);
    if (!text.trim()) return { label: null, description: null, model, error: "empty text file" };
    parts.push({ text: `\nDocument:\n${text}` });
  } else if (INLINE_OK.test(mime) && input.bytes.byteLength <= MAX_INLINE_BYTES) {
    parts.push({ inline_data: { mime_type: mime, data: bytesToBase64(input.bytes) } });
  } else {
    // Nothing we can feed the model (e.g. a huge or opaque binary) — analyze by name only.
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(input.apiKey)}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        // A description needs more output room than a bare label; turn "thinking"
        // off so Flash spends those tokens on the answer, not reasoning.
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 512,
          thinkingConfig: { thinkingBudget: 0 },
          responseMimeType: "application/json",
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const error = `gemini ${model} → ${res.status} ${res.statusText}`;
      console.warn(`[document-ai] ${error}: ${body.slice(0, 300)}`);
      return { label: null, description: null, model, error };
    }
    const data = (await res.json()) as GeminiResponse;
    const raw = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
    if (!raw) {
      const fin = data.candidates?.[0]?.finishReason ?? data.promptFeedback?.blockReason ?? "unknown";
      const error = `no text returned (finishReason=${fin})`;
      console.warn(`[document-ai] gemini ${model} ${error} for "${input.name}"`);
      return { label: null, description: null, model, error };
    }
    const parsed = parseAnalysis(raw);
    if (!parsed) {
      console.warn(`[document-ai] gemini ${model} returned unparseable JSON for "${input.name}": ${raw.slice(0, 200)}`);
      return { label: null, description: null, model, error: "unparseable model output" };
    }
    return { label: parsed.label, description: parsed.description, model };
  } catch (err) {
    const error = `request failed: ${(err as Error).message}`;
    console.warn(`[document-ai] gemini ${error}`);
    return { label: null, description: null, model, error };
  }
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
