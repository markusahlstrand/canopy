/**
 * The ⌘K assistant's wire contract, shared by the worker and the browser. Dependency-free
 * on purpose: the client imports the limits as values, and must not pull the route in.
 */

/** The most turns one request may carry. */
export const MAX_MESSAGES = 20;
/** A question someone typed. */
export const MAX_QUESTION_CHARS = 4_000;
/** An answer sent back as history: above what one answer can be (1,200 output tokens). */
export const MAX_ANSWER_CHARS = 12_000;

/** One turn of a conversation, as it rides a request. */
export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A file the answer rests on, addressed the way a link to it is. */
export interface AssistantSource {
  space: string;
  fileId: string;
  name: string;
}

export interface AssistantReply {
  answer: string;
  sources: AssistantSource[];
}

/**
 * The turns one request carries: the latest that fit, starting on a question. A window
 * that starts on an answer reads as a reply to nothing.
 */
export function historyWindow<T extends AssistantMessage>(turns: readonly T[]): T[] {
  const window = turns.slice(-MAX_MESSAGES);
  return window[0]?.role === 'assistant' ? window.slice(1) : window;
}
