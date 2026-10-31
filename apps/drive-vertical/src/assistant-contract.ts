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
 * The turns one request carries: the latest that fit — at most {@link MAX_MESSAGES}, and
 * within `charBudget` characters when given, the last turn always included — starting on
 * a question. A window that starts on an answer reads as a reply to nothing. The client
 * trims by count; the worker also by characters, against the model's context.
 */
export function historyWindow<T extends AssistantMessage>(turns: readonly T[], charBudget = Infinity): T[] {
  let start = Math.max(0, turns.length - MAX_MESSAGES);
  let used = 0;
  for (let i = turns.length - 1; i >= start; i--) {
    used += turns[i]!.content.length;
    if (used > charBudget && i < turns.length - 1) { start = i + 1; break; }
  }
  while (turns[start]?.role === 'assistant') start++;
  return turns.slice(start);
}
