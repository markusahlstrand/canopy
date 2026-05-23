/**
 * Minimal Google Gemini ("Flash") client for classifying a document into a short
 * type label. Multimodal: text-ish files are sent as text; PDFs/images are sent
 * as inline base64 so Flash reads them directly. Returns a 1-3 word label, or
 * null on any failure (labeling must never break an upload).
 */

const DEFAULT_MODEL = "gemini-3.5-flash";
const MAX_TEXT_CHARS = 12_000;
const MAX_INLINE_BYTES = 4 * 1024 * 1024; // ~4 MB before base64

const PROMPT =
  "You are a document classifier. Reply with a single concise document-type label of 1-3 words " +
  "(examples: Invoice, Receipt, Contract, Lease, Bank statement, Tax form, Resume, Letter, Report, " +
  "Manual, Presentation, Photo). Reply with ONLY the label — no quotes, no punctuation, no explanation.";

const TEXTUAL = /^(text\/|application\/(json|xml|x-yaml|yaml))/i;
const INLINE_OK = /^(application\/pdf|image\/(png|jpe?g|webp|gif|heic))/i;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

export interface ClassifyInput {
  apiKey: string;
  model?: string;
  name: string;
  mime: string;
  bytes: Uint8Array;
}

/** Classify a document; returns a short type label or null. */
export async function classifyDocument(input: ClassifyInput): Promise<string | null> {
  const mime = (input.mime || "").toLowerCase();
  const parts: Record<string, unknown>[] = [{ text: `${PROMPT}\nFilename: ${input.name}` }];

  if (TEXTUAL.test(mime)) {
    const text = new TextDecoder().decode(input.bytes).slice(0, MAX_TEXT_CHARS);
    if (!text.trim()) return null;
    parts.push({ text: `\nDocument:\n${text}` });
  } else if (INLINE_OK.test(mime) && input.bytes.byteLength <= MAX_INLINE_BYTES) {
    parts.push({ inline_data: { mime_type: mime, data: bytesToBase64(input.bytes) } });
  } else {
    // Nothing we can feed the model (e.g. a huge or opaque binary) — classify by name only.
  }

  const model = input.model?.trim() || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(input.apiKey)}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        // Flash "thinking" models spend output tokens on reasoning, so a tiny cap
        // yields an empty answer. Give headroom and turn thinking off for a fast,
        // direct label.
        generationConfig: { temperature: 0, maxOutputTokens: 256, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[document-ai] gemini ${model} → ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
      return null;
    }
    const data = (await res.json()) as GeminiResponse;
    const raw = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
    const label = raw.replace(/^["'\s.]+|["'\s.]+$/g, "").split("\n")[0]!.slice(0, 40);
    if (!label) {
      const fin = data.candidates?.[0]?.finishReason ?? data.promptFeedback?.blockReason ?? "unknown";
      console.warn(`[document-ai] gemini ${model} returned no text for "${input.name}" (finishReason=${fin})`);
    }
    return label || null;
  } catch (err) {
    console.warn(`[document-ai] gemini request failed: ${(err as Error).message}`);
    return null;
  }
}
