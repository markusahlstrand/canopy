import type { AiProvider, ConnectorConfigField } from "@canopy/core";
import { createGeminiAi } from "./gemini";
import { createOpenAiCompatAi, parseModelSpecs } from "./openai-compat";

/**
 * Per-user AI provider config — the keys a user enters in Settings → AI models,
 * stored encrypted in the same per-user settings store as the GitHub token. These
 * providers are layered (per caller) over the deployment's base providers (Workers
 * AI on Cloudflare, env keys), so a user's own key unlocks models only for them.
 */
export const AI_CONFIG_ID = "ai";

export const AI_PROVIDER_FIELDS: ConnectorConfigField[] = [
  { key: "googleApiKey", label: "Google AI API key (Gemini)", type: "secret" },
  { key: "openaiBaseUrl", label: "OpenAI-compatible base URL (e.g. a local model)", type: "url" },
  { key: "openaiApiKey", label: "OpenAI-compatible API key (optional)", type: "secret" },
  { key: "openaiModels", label: "Models — id|Label|vision, comma-separated", type: "string" },
];

/** Build the AI providers a user has configured from their decrypted settings. */
export function providersFromUserConfig(config: Record<string, string>): AiProvider[] {
  const out: AiProvider[] = [];
  if (config.googleApiKey) out.push(createGeminiAi(config.googleApiKey));
  if (config.openaiBaseUrl) {
    const models = parseModelSpecs(config.openaiModels);
    if (models.length) {
      out.push(createOpenAiCompatAi({ baseUrl: config.openaiBaseUrl, apiKey: config.openaiApiKey || undefined, models }));
    }
  }
  return out;
}
