import type { AiContentPart, AiMessage, AiModel, AiProvider } from "@canopy/core";
import { bytesToBase64 } from "./util";

/**
 * Google Gemini as an AI provider — the bring-your-own-key path for deployments not
 * on Cloudflare (set GOOGLE_AI_API_KEY). Gemini reads PDFs and images inline, so it
 * keeps the multimodal capability the Document AI plugin relies on. Generic: the
 * caller owns the prompt; this only maps our messages onto Gemini's request shape.
 */

export interface GeminiModelSpec {
  /** The Gemini model name, e.g. "gemini-3.5-flash" — used verbatim as the host-facing id. */
  id: string;
  label: string;
  vision?: boolean;
}

/** Default Gemini model exposed when only an API key is configured. */
export const GEMINI_MODELS: GeminiModelSpec[] = [
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", vision: true },
];

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

/** Map our content parts onto Gemini `parts` (`inline_data` for images/PDFs). */
function toGeminiParts(content: string | AiContentPart[]): Record<string, unknown>[] {
  if (typeof content === "string") return [{ text: content }];
  return content.map((p) =>
    p.kind === "text" ? { text: p.text } : { inline_data: { mime_type: p.mime, data: bytesToBase64(p.bytes) } },
  );
}

export function createGeminiAi(apiKey: string, specs: GeminiModelSpec[] = GEMINI_MODELS): AiProvider {
  const models: AiModel[] = specs.map((m) => ({ id: m.id, label: m.label, provider: "google", vision: m.vision }));
  return {
    models: () => models,
    async generate(req) {
      // "system" becomes Gemini's systemInstruction; user/assistant → user/model turns.
      const system = req.messages.filter((m) => m.role === "system");
      const turns = req.messages.filter((m): m is AiMessage => m.role !== "system");
      const body: Record<string, unknown> = {
        contents: turns.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: toGeminiParts(m.content) })),
        generationConfig: {
          ...(req.temperature != null ? { temperature: req.temperature } : {}),
          ...(req.maxTokens ? { maxOutputTokens: req.maxTokens } : {}),
          ...(req.json ? { responseMimeType: "application/json" } : {}),
          // Flash spends fewer tokens "thinking" so more go to the answer.
          ...(/flash/i.test(req.model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      };
      if (system.length) {
        body.system_instruction = { parts: system.flatMap((m) => toGeminiParts(m.content)) };
      }
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`gemini ${req.model} → ${res.status} ${res.statusText}: ${detail.slice(0, 200)}`);
      }
      const data = (await res.json()) as GeminiResponse;
      const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
      if (!text) {
        const fin = data.candidates?.[0]?.finishReason ?? data.promptFeedback?.blockReason ?? "unknown";
        throw new Error(`gemini ${req.model} returned no text (finishReason=${fin})`);
      }
      return { text, model: req.model };
    },
  };
}
