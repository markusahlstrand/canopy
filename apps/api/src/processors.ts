import type { ConnectorConfigField } from "@canopy/core";
import { classifyDocument } from "./gemini";

/**
 * Server-side **document processors** — trusted code that runs when a file is
 * added and returns labels to merge into its metadata. This is the "server-side
 * processor" shape (a future `enrichItem` / `transformUpload` plugin hook); until
 * the sandbox runtime exists it runs first-party in the API, exactly like a data
 * source. Config (e.g. an API key) is per-user and stored encrypted.
 */
export interface ProcessorFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface DocumentProcessor {
  id: string;
  configFields: ConnectorConfigField[];
  /** Return labels to merge into the file's metadata, or [] to skip. */
  label(file: ProcessorFile, config: Record<string, string>): Promise<string[]>;
}

/** Classifies each added document into a type label via Google Gemini Flash. */
export const documentAiProcessor: DocumentProcessor = {
  id: "document-ai",
  configFields: [
    { key: "apiKey", label: "Google AI API key", type: "secret", required: true },
    { key: "model", label: "Model (default: gemini-3.5-flash)", type: "string" },
  ],
  async label(file, config) {
    if (!config.apiKey) return [];
    const type = await classifyDocument({
      apiKey: config.apiKey,
      model: config.model,
      name: file.name,
      mime: file.mime,
      bytes: file.bytes,
    });
    return type ? [type] : [];
  },
};

export const PROCESSORS: DocumentProcessor[] = [documentAiProcessor];
