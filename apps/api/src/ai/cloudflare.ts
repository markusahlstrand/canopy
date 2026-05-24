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
}

/**
 * The default Workers AI model(s) exposed when the binding is present. Gemma 4 26B
 * (MoE, 26B/4B-active, 256K context, vision) reads documents and images directly,
 * with no per-user key — the deployment pays. Add more by editing this list.
 */
export const CLOUDFLARE_MODELS: CloudflareModelSpec[] = [
  { id: "@cf/google/gemma-4-26b-a4b-it", label: "Gemma 4 26B", vision: true },
];

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
  const models: AiModel[] = specs.map((m) => ({ id: m.id, label: m.label, provider: "cloudflare", vision: m.vision }));
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
