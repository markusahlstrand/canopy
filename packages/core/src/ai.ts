/**
 * AI inference as a host capability. Like `StorageConnector` and `CacheStore`, this
 * is a Q2 capability (see "What belongs in the core"): a thin interface here, a
 * swappable adapter per deployment, reached by plugins through the host — never by
 * the plugin holding a key. The deployment decides which providers it runs:
 * Cloudflare Workers AI via the `env.AI` binding (no per-user key), a hosted
 * API-key provider (Google Gemini), or any OpenAI-compatible endpoint (including a
 * local model). The **union** of their models is the list plugins see and pick from.
 *
 * Zero runtime deps. `createAiGateway` is the only runtime export.
 */

/** A model the deployment exposes. `id` is what a plugin stores and passes to `generate`. */
export interface AiModel {
  /** Stable id, unique across providers, e.g. "@cf/google/gemma-4-26b-a4b-it". */
  id: string;
  /** Friendly label for a picker, e.g. "Gemma 4 26B". */
  label: string;
  /** The provider serving it, for display/grouping, e.g. "cloudflare" | "google". */
  provider: string;
  /** True when it accepts inline image (and, where supported, document) input, not just text. */
  vision?: boolean;
  /** One-line "what it's good for", shown beneath the label in a picker. Optional. */
  description?: string;
}

/** One part of a message: plain text, or an inline binary (image / PDF) the model reads. */
export type AiContentPart =
  | { kind: "text"; text: string }
  | { kind: "image"; mime: string; bytes: Uint8Array };

export interface AiMessage {
  role: "system" | "user" | "assistant";
  /** A bare string is shorthand for a single text part. */
  content: string | AiContentPart[];
}

export interface AiGenerateRequest {
  /** A model id from `models()`. */
  model: string;
  messages: AiMessage[];
  /** 0 = deterministic. Adapters map this onto the provider's own scale. */
  temperature?: number;
  /** Cap on generated tokens. */
  maxTokens?: number;
  /** Ask for a strict-JSON reply where the provider supports it. */
  json?: boolean;
}

export interface AiGenerateResult {
  /** The generated text (a JSON string when `json` was requested). */
  text: string;
  /** The model actually used (for logging). */
  model: string;
}

/**
 * One inference backend: a wrapped `env.AI` binding, a Gemini key, or an
 * OpenAI-compatible endpoint. `generate` throws on failure — the gateway and the
 * calling plugin decide how to surface it (Document AI records it in a file's log).
 */
export interface AiProvider {
  /** Models this provider currently exposes (empty if it isn't configured). */
  models(): AiModel[];
  generate(req: AiGenerateRequest): Promise<AiGenerateResult>;
}

/**
 * The host-facing AI surface handed to trusted, in-process callers (processors
 * today; the sandboxed `ai:generate` grant later): the union of every configured
 * provider's models, and a `generate` that routes to whichever provider owns the
 * requested model.
 */
export interface AiGateway {
  models(): AiModel[];
  generate(req: AiGenerateRequest): Promise<AiGenerateResult>;
}

/**
 * Build a gateway over an ordered list of providers. On a duplicate model id the
 * earlier provider wins (so a deployment can shadow a default by listing its own
 * provider first).
 */
export function createAiGateway(providers: AiProvider[]): AiGateway {
  return {
    models() {
      const seen = new Set<string>();
      const out: AiModel[] = [];
      for (const p of providers) {
        for (const m of p.models()) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          out.push(m);
        }
      }
      return out;
    },
    generate(req) {
      const owner = providers.find((p) => p.models().some((m) => m.id === req.model));
      if (!owner) throw new Error(`no provider exposes model "${req.model}"`);
      return owner.generate(req);
    },
  };
}
