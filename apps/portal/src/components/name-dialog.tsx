import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * What a single-name ask looks like. Hosts keep one `NamePrompt | null` in
 * state and render a `NameDialog` from it — the in-app replacement for
 * `window.prompt` (new folder, renames, new file), so every name flow shares
 * one styled modal instead of a native browser dialog.
 */
export interface NamePrompt {
  title: string;
  description?: string;
  placeholder?: string;
  /** Prefilled value (selected on focus, like the native prompt was). */
  initial?: string;
  submitLabel?: string;
  /** Throwing keeps the dialog open with the message shown inline. */
  onSubmit: (name: string) => void | Promise<void>;
}

export function NameDialog({
  prompt,
  onOpenChange,
}: {
  prompt: NamePrompt;
  onOpenChange: (open: boolean) => void;
}) {
  const [value, setValue] = useState(prompt.initial ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const name = value.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      await prompt.onSubmit(name);
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{prompt.title}</DialogTitle>
          {prompt.description && <DialogDescription>{prompt.description}</DialogDescription>}
        </DialogHeader>
        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
          <Input
            autoFocus
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            onFocus={(e) => e.currentTarget.select()}
            placeholder={prompt.placeholder}
            disabled={busy}
          />
          {error && <p className="text-[12.5px] text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !value.trim()}>
              {busy ? "Working…" : (prompt.submitLabel ?? "Save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
