import type { ConnectorConfigField } from "@canopy/core";
import { analyzeDocument } from "./gemini";

/**
 * Server-side **document processors** — trusted code that runs when a file is
 * added and returns metadata to merge into it (type labels, a description). This
 * is the "server-side processor" shape (a future `enrichItem` / `transformUpload`
 * plugin hook); until the sandbox runtime exists it runs first-party in the API,
 * exactly like a data source. Config (e.g. an API key) is per-user and stored
 * encrypted.
 */
export interface ProcessorFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

/** What a processor produces for one file. */
export interface ProcessorResult {
  /** Type labels to merge into metadata.labels. */
  labels: string[];
  /** A generated description for metadata.description (only set if absent). */
  description?: string;
  /** Identifier of the model/engine used, for the processing log. */
  model?: string;
  /** Set when the run failed; recorded in the processing log, never thrown. */
  error?: string;
}

/**
 * One entry in a file's processing log (`metadata.processing`), written each time
 * a processor runs over the file. Lets a user see whether — and how — the file was
 * processed. Newest entries are appended; the UI shows them newest-first.
 */
export interface ProcessingEntry {
  /** ISO timestamp of the run. */
  at: string;
  /** Processor id (e.g. "document-ai"). */
  plugin: string;
  status: "ok" | "error";
  /** Model/engine used, when known. */
  model?: string;
  /** Labels produced by this run. */
  labels?: string[];
  /** Whether this run wrote a description. */
  described?: boolean;
  /** Error message (status "error") or other note. */
  note?: string;
}

export interface DocumentProcessor {
  id: string;
  configFields: ConnectorConfigField[];
  /** Analyze a freshly-added file and return labels / description to merge. */
  process(file: ProcessorFile, config: Record<string, string>): Promise<ProcessorResult>;
}

/** Classifies and describes each added document via Google Gemini Flash. */
export const documentAiProcessor: DocumentProcessor = {
  id: "document-ai",
  configFields: [
    { key: "apiKey", label: "Google AI API key", type: "secret", required: true },
    { key: "model", label: "Model (default: gemini-3.5-flash)", type: "string" },
    { key: "language", label: "Output language (default: English)", type: "string" },
  ],
  async process(file, config) {
    if (!config.apiKey) return { labels: [], error: "no API key" };
    const r = await analyzeDocument({
      apiKey: config.apiKey,
      model: config.model,
      language: config.language,
      name: file.name,
      mime: file.mime,
      bytes: file.bytes,
    });
    return {
      labels: r.label ? [r.label] : [],
      description: r.description ?? undefined,
      model: r.model,
      error: r.error,
    };
  },
};

export const PROCESSORS: DocumentProcessor[] = [documentAiProcessor];
