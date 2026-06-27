import type { AiModel, AiProvider } from "@canopy/core";
import { toOpenAiMessages } from "./util";

/**
 * The Cloudflare Workers AI binding (`env.AI`). We only use `run`; typed loosely
 * because the payload/return shape varies per model family.
 */
export interface WorkersAiBinding {
  run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

/** A model this deployment chooses to expose from the Workers AI catalog. */
export interface CloudflareModelSpec {
  /** The `@cf/...` model slug, used verbatim as the host-facing model id. */
  id: string;
  label: string;
  vision?: boolean;
  /** One-line "what it's good for", surfaced in model pickers. */
  description?: string;
}

/**
 * The default Workers AI chat models exposed when the binding is present — no
 * per-user key, the deployment pays. A curated menu replacing a Gemini Flash setup,
 * grouped by task with a "powerhouse" and an "efficiency" pick each (see the
 * `description` fields). The first entry is the zero-config default (`models[0]`); the
 * host also routes by capability — images to the first vision model, code generation
 * to a code model (see processors.ts / plugin-studio). Add or reorder freely.
 *
 * Embedding models are *not* chat models (they take no messages), so the embedding
 * default lives separately in `CLOUDFLARE_EMBEDDING_MODEL` below.
 */
export const CLOUDFLARE_MODELS: CloudflareModelSpec[] = [
  // ── General / daily driver (vision) ──
  {
    id: "@cf/google/gemma-4-26b-a4b-it",
    label: "Gemma 4 26B",
    vision: true,
    description:
      "Daily driver for text, categorization, image vision, and JSON — its native reasoning track keeps long extractions syntactically clean.",
  },
  // ── Image analysis (vision) ──
  {
    id: "@cf/meta/llama-4-scout-17b-16e-instruct",
    label: "Llama 4 Scout 17B",
    vision: true,
    description:
      "Natively multimodal 16-expert MoE — industry-leading image understanding for pinpointing people and objects.",
  },
  {
    id: "@cf/mistralai/mistral-small-3.1-24b-instruct",
    label: "Mistral Small 3.1 24B",
    vision: true,
    description: "Efficient 24B with state-of-the-art vision — low-latency image tasks.",
  },
  // ── Code generation & heavy extraction ──
  {
    id: "@cf/moonshotai/kimi-k2.7-code",
    label: "Kimi K2.7 Code",
    vision: true,
    description:
      "Frontier 1T-param model, 262K context, structured outputs — powerhouse for massive document extraction and complex plugin code.",
  },
  {
    id: "@cf/zai-org/glm-5.2",
    label: "GLM-5.2",
    description: "Z.ai's flagship agentic coding model — snappy specialized code synthesis, 262K context.",
  },
  {
    id: "@cf/qwen/qwen2.5-coder-32b-instruct",
    label: "Qwen2.5 Coder 32B",
    description: "Developer-focused 32B code model — fast, specialized syntax generation.",
  },
  // ── Categorization / strict JSON ──
  {
    id: "@cf/openai/gpt-oss-120b",
    label: "GPT-OSS 120B",
    description:
      "120B powerhouse for strict-JSON categorization — flawless schema adherence and logical consistency.",
  },
  {
    id: "@cf/qwen/qwen3-30b-a3b-fp8",
    label: "Qwen3 30B",
    description:
      "Efficient MoE with built-in reasoning and function calling — high-volume categorization at a fraction of the cost.",
  },
];

/**
 * The default Workers AI embedding model — Qwen3-Embedding-0.6B (1024-dim, cosine,
 * 4,096-token inputs, good for longer chunks). Used by the embedding/vector path
 * (search ranking, Vectorize) rather than the chat gateway; kept here so the
 * deployment's model choices live in one place.
 */
export const CLOUDFLARE_EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";

/** Pull text out of whatever shape the binding returned (chat `response` or OpenAI `choices`). */
function extractText(out: unknown): string {
  if (typeof out === "string") return out;
  const o = out as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
  if (typeof o.response === "string") return o.response;
  const choice = o.choices?.[0]?.message?.content;
  if (typeof choice === "string") return choice;
  return "";
}

/** An AI provider backed by the Workers AI binding. Only available on the Worker. */
export function createCloudflareAi(binding: WorkersAiBinding, specs: CloudflareModelSpec[] = CLOUDFLARE_MODELS): AiProvider {
  const models: AiModel[] = specs.map((m) => ({
    id: m.id,
    label: m.label,
    provider: "cloudflare",
    vision: m.vision,
    description: m.description,
  }));
  return {
    models: () => models,
    async generate(req) {
      const inputs: Record<string, unknown> = { messages: toOpenAiMessages(req.messages) };
      if (req.maxTokens) inputs.max_tokens = req.maxTokens;
      if (req.temperature != null) inputs.temperature = req.temperature;
      if (req.json) inputs.response_format = { type: "json_object" };
      const out = await binding.run(req.model, inputs);
      const text = extractText(out);
      if (!text) throw new Error(`workers-ai ${req.model} returned no text`);
      return { text, model: req.model };
    },
  };
}
