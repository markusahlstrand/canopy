import * as vscode from "vscode";
import type { AiMessage, AiModel, PluginAiRequest } from "@canopy/plugin-sdk";

/**
 * Bridges the model-editor's `HostBridge.aiGenerate` / `listAiModels` to VS Code's
 * Language Model API (Copilot). The portal routes these through Canopy's AI gateway;
 * in VS Code we use whatever chat model the user already has access to. No key or
 * Canopy backend is involved — VS Code prompts for consent on first use.
 */

function flattenContent(content: AiMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.kind === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Map our role-tagged messages to VS Code chat messages. The LM API has only
 * User/Assistant turns (no dedicated system role), so a `system` message is sent
 * as a leading user turn — the common workaround.
 */
function toChatMessages(messages: AiMessage[]): vscode.LanguageModelChatMessage[] {
  return messages.map((m) => {
    const text = flattenContent(m.content);
    return m.role === "assistant"
      ? vscode.LanguageModelChatMessage.Assistant(text)
      : vscode.LanguageModelChatMessage.User(text);
  });
}

async function pickModel(preferredId?: string): Promise<vscode.LanguageModelChat> {
  const all = await vscode.lm.selectChatModels();
  const first = all[0];
  if (!first) {
    throw new Error(
      "No language model is available. Install and sign in to GitHub Copilot (or another Chat provider) to use the assistant.",
    );
  }
  return all.find((m) => m.id === preferredId) ?? first;
}

export async function aiGenerate(req: PluginAiRequest, token: vscode.CancellationToken): Promise<string> {
  const model = await pickModel(req.model);
  const response = await model.sendRequest(toChatMessages(req.messages), {}, token);
  let out = "";
  for await (const chunk of response.text) out += chunk;
  return out;
}

export async function listAiModels(): Promise<AiModel[]> {
  const all = await vscode.lm.selectChatModels();
  return all.map((m) => ({
    id: m.id,
    label: m.name ?? m.id,
    provider: m.vendor,
  }));
}
