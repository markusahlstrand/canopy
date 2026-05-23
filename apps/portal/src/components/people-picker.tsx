import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { PersonAvatar } from "@/components/person-avatar";
import { cn } from "@/lib/utils";
import { searchPeople, type Person } from "@/lib/api";

/**
 * A text field that suggests **connected people** (space co-members + file-share
 * peers) as you type, so you pick a known contact instead of retyping an address.
 *
 * It owns only the suggestion dropdown; the surrounding `<form>` keeps the raw
 * fallback — typing a full email and pressing Enter submits the form (when no
 * suggestion is highlighted), letting you still invite someone you've never met.
 */
export function PeoplePicker({
  value,
  onChange,
  onPick,
  placeholder = "Add by name or email…",
  disabled,
  exclude,
}: {
  value: string;
  onChange: (v: string) => void;
  /** A connected person was chosen from the dropdown. */
  onPick: (person: Person) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Hide people already added (e.g. existing grants/members). */
  exclude?: (p: Person) => boolean;
}) {
  const [results, setResults] = useState<Person[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  // Debounced server search as the caller types (all state updates happen in the
  // deferred callback, never synchronously in the effect body).
  useEffect(() => {
    const term = value.trim();
    let cancelled = false;
    const t = setTimeout(
      () => {
        if (!term) {
          setResults([]);
          setOpen(false);
          return;
        }
        void searchPeople(term).then((people) => {
          if (cancelled) return;
          const filtered = exclude ? people.filter((p) => !exclude(p)) : people;
          setResults(filtered);
          setActive(0);
          setOpen(filtered.length > 0);
        });
      },
      term ? 180 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [value, exclude]);

  // Close when clicking outside the picker.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function choose(p: Person) {
    onPick(p);
    setResults([]);
    setOpen(false);
  }

  const label = (p: Person) => p.name ?? p.email ?? p.sub;

  return (
    <div ref={boxRef} className="relative flex-1">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        onKeyDown={(e) => {
          // While a suggestion is highlighted, the arrows/Enter drive the list
          // and never reach the form (so Enter picks a person, not submits).
          if (!open || results.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => (i + 1) % results.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => (i - 1 + results.length) % results.length);
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(results[active]!);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        data-bwignore
        data-1p-ignore
        data-lpignore="true"
      />
      {open && results.length > 0 && (
        <div className="absolute z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border bg-popover p-1 shadow-md">
          {results.map((p, i) => (
            <button
              key={p.sub}
              type="button"
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left",
                i === active ? "bg-accent" : "hover:bg-accent",
              )}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(p)}
            >
              <PersonAvatar name={label(p)} size="md" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px]">{label(p)}</span>
                {p.name && p.email && (
                  <span className="block truncate text-[11.5px] text-muted-foreground">{p.email}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
