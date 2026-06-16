import { useEffect, useRef, useState } from "react";
import { aiGenerate, listAiModels, type AiModel } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Icon } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { PROPERTY_TYPES, type DomainModel } from "./types";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  /** True when this assistant turn produced a model that was applied. */
  applied?: boolean;
}

const SYSTEM_PROMPT = `You are a senior data modeller embedded in a visual entity-relation editor.
Your job is to interview the user about their domain and incrementally build a data model with them.

Behaviour:
- Ask focused clarifying questions ONE topic at a time until you understand the entities, their key properties, and how they relate. Don't dump a wall of questions.
- As soon as you have enough to make a useful first proposal, emit a model. Keep refining it on later turns as the user gives more detail.
- When the user gives concrete domain facts, prefer acting (updating the model) over asking more.
- Always return the COMPLETE model, never a partial diff.

You MUST respond with a single JSON object, no prose outside it:
{
  "message": string,            // your reply / next question shown in the chat
  "model": null | {
    "name": string,
    "entities": [{
      "name": string,
      "description"?: string,
      "color"?: "green"|"blue"|"violet"|"orange"|"rose"|"cyan"|"amber"|"zinc",
      "properties": [{
        "name": string,
        "type": ${PROPERTY_TYPES.map((t) => `"${t}"`).join("|")},
        "required"?: boolean,
        "unique"?: boolean,
        "primaryKey"?: boolean,
        "enumValues"?: string[],     // when type is "enum"
        "refEntityId"?: string,      // when type is "ref": the TARGET entity name
        "description"?: string
      }]
    }],
    "relations": [{
      "name"?: string,
      "from": string,              // source entity name
      "to": string,                // target entity name
      "cardinality": "1-1"|"1-N"|"N-1"|"N-M",
      "fromLabel"?: string,
      "toLabel"?: string
    }]
  }
}
Set "model" to null while you are still only gathering requirements. Give every entity a primary key.`;

export interface AssistantPanelProps {
  getModel: () => DomainModel;
  onApply: (model: unknown) => void;
}

export function AssistantPanel({ getModel, onApply }: AssistantPanelProps) {
  const [models, setModels] = useState<AiModel[] | null>(null);
  const [modelId, setModelId] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      text: "Hi! Tell me what you're building and I'll help you design the data model. What's the system about?",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void listAiModels().then((m) => {
      setModels(m);
      if (m[0]) setModelId(m[0].id);
    });
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const aiAvailable = models === null || models.length > 0;

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setError(null);
    const history = [...messages, { role: "user" as const, text }];
    setMessages(history);
    setBusy(true);
    try {
      const current = getModel();
      const apiMessages = [
        { role: "system" as const, content: SYSTEM_PROMPT },
        {
          role: "user" as const,
          content: `Current model (JSON):\n${JSON.stringify(stripPositions(current))}`,
        },
        ...history.map((m) => ({ role: m.role, content: m.text })),
      ];
      const raw = await aiGenerate({
        messages: apiMessages,
        model: modelId || undefined,
        json: true,
        maxTokens: 4000,
        temperature: 0.4,
      });
      const parsed = parseResponse(raw);
      let applied = false;
      if (parsed.model && typeof parsed.model === "object") {
        onApply(parsed.model);
        applied = true;
      }
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: parsed.message || (applied ? "Updated the canvas." : "…"), applied },
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      {models !== null && !aiAvailable && (
        <div className="m-3 rounded-lg border border-dashed p-3 text-[12px] text-muted-foreground">
          No AI model is configured on this deployment, so the assistant is unavailable. You can still
          build the model by hand on the canvas and export it.
        </div>
      )}

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-3">
        {messages.map((m, i) => (
          <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-[13px] leading-relaxed",
                m.role === "user"
                  ? "rounded-br-sm bg-primary text-primary-foreground"
                  : "rounded-bl-sm bg-muted text-foreground",
              )}
            >
              {m.text}
              {m.applied && (
                <div className="mt-1.5 flex items-center gap-1 text-[11px] opacity-70">
                  <Icon name="circle-check" size={12} /> Applied to canvas
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-[13px] text-muted-foreground">
              <span className="inline-flex gap-1">
                <Dot /> <Dot /> <Dot />
              </span>
            </div>
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-[12px] text-destructive">
            {error}
          </div>
        )}
      </div>

      <div className="border-t p-3">
        {models && models.length > 1 && (
          <Select value={modelId} onValueChange={setModelId}>
            <SelectTrigger size="sm" className="mb-2 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            disabled={!aiAvailable}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder={aiAvailable ? "Describe your domain…" : "AI unavailable"}
            className="max-h-32 min-h-[40px] flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-[13px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
          />
          <Button size="icon" onClick={() => void send()} disabled={busy || !input.trim() || !aiAvailable}>
            <Icon name="chevron-right" size={18} />
          </Button>
        </div>
      </div>
    </div>
  );
}

function Dot() {
  return <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-duration:1s]" />;
}

function stripPositions(model: DomainModel) {
  return {
    name: model.name,
    entities: model.entities.map((e) => ({
      name: e.name,
      description: e.description,
      properties: e.properties,
    })),
    relations: model.relations.map((r) => ({
      name: r.name,
      from: model.entities.find((e) => e.id === r.fromEntityId)?.name,
      to: model.entities.find((e) => e.id === r.toEntityId)?.name,
      cardinality: r.cardinality,
      fromLabel: r.fromLabel,
      toLabel: r.toLabel,
    })),
  };
}

function parseResponse(raw: string): { message: string; model?: unknown } {
  const text = raw.trim();
  // Tolerate ```json fences or leading prose even though we asked for pure JSON.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(candidate.slice(start, end + 1)) as { message?: string; model?: unknown };
      return { message: obj.message ?? "", model: obj.model ?? undefined };
    } catch {
      /* fall through */
    }
  }
  return { message: text };
}
