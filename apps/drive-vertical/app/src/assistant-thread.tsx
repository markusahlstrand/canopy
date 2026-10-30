import { Button, Icon } from "@canopy/ui";
import { FileIcon } from "./file-icon";
import { kindOf } from "./items";
import type { AssistantSource } from "./api";

/** A turn as the palette keeps it: an answer remembers the files it rests on. */
export interface AssistantTurn {
  role: "user" | "assistant";
  content: string;
  sources?: AssistantSource[];
}

interface AssistantThreadProps {
  turns: AssistantTurn[];
  asking: boolean;
  error: string | null;
  onRetry: () => void;
  onOpenSource: (source: AssistantSource) => void;
  /** Slug → name, to say which space a source lives in when it is not this one. */
  spaceNames: Map<string, string>;
  currentSpace?: string;
  onBack: () => void;
  onReset: () => void;
}

/**
 * The conversation half of ⌘K.
 *
 * Answers render as plain text and never as markup: document text reaches the model, and
 * an answer that could carry an image or a link would be a way for a document to make the
 * browser fetch a URL. The sources are what can be clicked, and they are file ids the
 * worker returned, not anything the model wrote.
 */
export function AssistantThread({ turns, asking, error, onRetry, onOpenSource, spaceNames, currentSpace, onBack, onReset }: AssistantThreadProps) {
  return (
    <div className="flex flex-col gap-3 p-3">
      <div role="log" aria-label="Assistant conversation" aria-live="polite" className="flex flex-col gap-3">
        {turns.length === 0 && !asking ? (
          <p className="text-sm text-muted-foreground">
            Ask about anything in your documents — “when does the lease end?”, “what did we pay ACME last year?”.
            The assistant searches every space you can open.
          </p>
        ) : null}
        {turns.map((turn, i) =>
          turn.role === "user" ? (
            <p key={i} className="self-end max-w-[85%] whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm">{turn.content}</p>
          ) : (
            <div key={i} className="flex flex-col gap-2">
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{turn.content}</p>
              {turn.sources?.length ? (
                <ul aria-label="Sources" className="flex flex-wrap gap-1.5">
                  {turn.sources.map((source) => (
                    <li key={`${source.space}/${source.fileId}`}>
                      <button
                        type="button"
                        onClick={() => onOpenSource(source)}
                        className="flex max-w-[260px] items-center gap-1.5 rounded-md border px-2 py-1 text-[12.5px] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <FileIcon kind={kindOf(null, source.name)} size={16} />
                        <span className="truncate">{source.name}</span>
                        {source.space !== currentSpace ? (
                          <span className="shrink-0 text-muted-foreground">· {spaceNames.get(source.space) ?? source.space}</span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ),
        )}
        {asking ? <p role="status" className="text-sm text-muted-foreground">Searching your documents…</p> : null}
        {error ? (
          <div className="flex items-center gap-2">
            <p role="alert" className="flex-1 text-sm">{error}</p>
            <Button size="sm" variant="outline" onClick={onRetry}><Icon name="refresh" size={14} />Retry</Button>
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-2 border-t pt-2">
        <Button size="sm" variant="ghost" onClick={onBack}><Icon name="chevron-left" size={14} />Search</Button>
        {turns.length ? <Button size="sm" variant="ghost" onClick={onReset}><Icon name="plus" size={14} />New conversation</Button> : null}
        <span className="ml-auto text-[11.5px] text-muted-foreground">AI answers from your documents — check anything important.</span>
      </div>
    </div>
  );
}
