import type { AiModel, AiProvider } from "@canopy/core";
import { toOpenAiMessages } from "./util";

/**
 * Any OpenAI-compatible chat-completions endpoint as an AI provider — the easy path
 * for **local models** (Ollama at http://localhost:11434/v1, LM Studio, vLLM) and
 * for OpenAI itself. So a self-hosted Gemma can back Document AI in local dev with
 * no Cloudflare. Configure via OPENAI_BASE_URL (+ optional key / model list).
 */

export interface OpenAiCompatModelSpec {
  /** The model name the endpoint expects, used verbatim as the host-facing id. */
  id: string;
  label: string;
  vision?: boolean;
}

export interface OpenAiCompatConfig {
  /** Base URL including the version segment, e.g. "http://localhost:11434/v1". */
  baseUrl: string;
  /** Bearer token, if the endpoint needs one (omit for most local servers). */
  apiKey?: string;
  /** Provider label shown in the picker, e.g. "ollama" | "openai". */
  label?: string;
  models: OpenAiCompatModelSpec[];
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
}

export function createOpenAiCompatAi(cfg: OpenAiCompatConfig): AiProvider {
  const provider = cfg.label || "openai";
  const models: AiModel[] = cfg.models.map((m) => ({ id: m.id, label: m.label, provider, vision: m.vision }));
  const endpoint = `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
  return {
    models: () => models,
    async generate(req) {
      const body: Record<string, unknown> = { model: req.model, messages: toOpenAiMessages(req.messages) };
      if (req.maxTokens) body.max_tokens = req.maxTokens;
      if (req.temperature != null) body.temperature = req.temperature;
      if (req.json) body.response_format = { type: "json_object" };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`${provider} ${req.model} → ${res.status} ${res.statusText}: ${detail.slice(0, 200)}`);
      }
      const data = (await res.json()) as ChatResponse;
      const text = data.choices?.[0]?.message?.content?.trim() ?? "";
      if (!text) throw new Error(`${provider} ${req.model} returned no text`);
      return { text, model: req.model };
    },
  };
}

/**
 * Parse an OPENAI_MODELS-style list: comma-separated `id` entries, each optionally
 * `id|Label` and optionally `|vision`. E.g. "gemma3:27b|Gemma 3 27B|vision, llama3.1".
 */
export function parseModelSpecs(raw: string | undefined): OpenAiCompatModelSpec[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, label, flag] = entry.split("|").map((x) => x.trim());
      return { id: id!, label: label || id!, vision: flag?.toLowerCase() === "vision" };
    });
}
