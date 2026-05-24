import type { AiMessage } from "@canopy/core";

/** Base64-encode bytes (works on a Worker and Node — no Buffer). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

/** A `data:` URL for an inline binary, the form OpenAI-style `image_url` parts want. */
export function dataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

/** One OpenAI-style content part (text or an image as a data URL). */
type OpenAiPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

/**
 * Map our provider-neutral messages onto the OpenAI chat shape shared by Cloudflare
 * Workers AI and any OpenAI-compatible endpoint. A bare-string `content` stays a
 * string; parts become a content array. Images ride as `image_url` data URLs.
 */
export function toOpenAiMessages(messages: AiMessage[]): { role: string; content: string | OpenAiPart[] }[] {
  return messages.map((m) => {
    if (typeof m.content === "string") return { role: m.role, content: m.content };
    const parts: OpenAiPart[] = m.content.map((p) =>
      p.kind === "text"
        ? { type: "text", text: p.text }
        : { type: "image_url", image_url: { url: dataUrl(p.mime, p.bytes) } },
    );
    return { role: m.role, content: parts };
  });
}
