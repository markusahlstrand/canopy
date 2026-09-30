import { useEffect, useRef, useState } from 'react';
import { Input, PersonAvatar, cn } from '@canopy/ui';
import type { Person } from './api';

/**
 * A text field that suggests the people already in this space as you type, so you pick a
 * known person instead of retyping an address.
 *
 * Moved from the portal (`apps/portal/src/components/people-picker.tsx`) and adapted in one
 * place: it filtered a server search (`searchPeople`) and now filters a list its caller
 * already has. The vertical has no people-search endpoint and does not need one — a space's
 * roster is tens of rows, already fetched for the list underneath, and a request per keystroke
 * to re-sort thirty names would be worse in every way. The debounce went with the request.
 *
 * The portal's `exclude` predicate is gone with the search: both callers here need the filtered
 * list for their own copy anyway ("everyone already has access"), so they pass what they mean
 * and this suggests all of it. A prop no caller uses is a prop no test covers.
 *
 * It owns only the suggestion dropdown; the surrounding `<form>` keeps the raw fallback —
 * typing a full email and pressing Enter submits the form when no suggestion is highlighted,
 * which is how you reach somebody who is not in the space yet.
 */
export function PeoplePicker({
  value,
  onChange,
  onPick,
  people,
  placeholder = 'Add by name or email…',
  disabled,
  label = 'Person',
}: {
  value: string;
  onChange: (v: string) => void;
  /** A person was chosen from the dropdown. */
  onPick: (person: Person) => void;
  /** Who there is to suggest — the roster the caller already read. */
  people: Person[];
  placeholder?: string;
  disabled?: boolean;
  /** The field's accessible name, since a screen may hold two of these. */
  label?: string;
}) {
  const [results, setResults] = useState<Person[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  // Filtered from what the caller already has. No request, so no debounce and no race —
  // the two things the portal's version needed a timer and a cancellation flag for.
  useEffect(() => {
    const term = value.trim().toLowerCase();
    if (!term) {
      setResults([]);
      setOpen(false);
      return;
    }
    const matches = people.filter((p) =>
      [p.name, p.email].some((field) => field?.toLowerCase().includes(term)),
    );
    setResults(matches);
    setActive(0);
    setOpen(matches.length > 0);
  }, [value, people]);

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

  const nameOf = (p: Person) => p.name ?? p.email ?? p.principal;

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
        aria-label={label}
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
              key={p.principal}
              type="button"
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left",
                i === active ? "bg-accent" : "hover:bg-accent",
              )}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(p)}
            >
              <PersonAvatar name={nameOf(p)} size="md" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px]">{nameOf(p)}</span>
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
