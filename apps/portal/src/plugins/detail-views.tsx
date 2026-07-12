import { useEffect, useState } from "react";
import {
  PersonAvatar,
  Checkbox,
  Badge,
  Icon,
  cn,
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@canopy/ui";
import { createTask, listCalendars, type Calendar, type Task, type TaskStatus } from "@/lib/api";
import { usePluginDataRefresh, useTasks } from "./data";

const STATUS_META: Record<TaskStatus, { title: string; color: string }> = {
  todo: { title: "To do", color: "212 70% 48%" },
  in_progress: { title: "In progress", color: "145 33% 36%" },
  blocked: { title: "Blocked", color: "0 72% 51%" },
  done: { title: "Done", color: "220 9% 46%" },
};
const STATUS_ORDER: TaskStatus[] = ["todo", "in_progress", "blocked", "done"];

/** A small pill telling the user whether they're seeing live or sample data. */
function SourcePill({ source }: { source: "github" | "sample" | "owned" | "owned+github" }) {
  if (source !== "sample") {
    const label =
      source === "github" ? "Live from GitHub" : source === "owned" ? "Your data" : "Your data + GitHub";
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-[11.5px] font-medium text-primary">
        <span className="size-1.5 rounded-full bg-primary" /> {label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[11.5px] text-muted-foreground">
      Sample data · install the GitHub plugin for live data
    </span>
  );
}

function TaskCard({ t }: { t: Task }) {
  const done = t.status === "done";
  const Title = t.url ? "a" : "span";
  return (
    <div className="rounded-md border bg-muted/50 p-2.5" style={{ opacity: done ? 0.6 : 1 }}>
      <div className="flex items-center gap-2">
        <Checkbox defaultChecked={done} />
        <Title
          {...(t.url ? { href: t.url, target: "_blank", rel: "noreferrer" } : {})}
          className={`flex-1 truncate text-[13.5px] font-medium ${done ? "line-through" : ""} ${t.url ? "hover:underline" : ""}`}
        >
          {t.title}
        </Title>
        {t.assignee && <PersonAvatar name={t.assignee} size="xs" />}
      </div>
      {(t.due || t.priority === "high" || (t.labels && t.labels.length > 0)) && !done && (
        <div className="ml-6 mt-1.5 flex flex-wrap items-center gap-1.5">
          {t.due && (
            <span className="font-mono text-[11.5px] text-muted-foreground">
              {new Date(t.due).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </span>
          )}
          {t.priority === "high" && (
            <Badge variant="outline" className="border-destructive/40 px-1 py-0 text-[10px] text-destructive">
              High
            </Badge>
          )}
          {t.labels?.slice(0, 2).map((l) => (
            <Badge key={l} variant="outline" className="px-1 py-0 text-[10px] text-muted-foreground">
              {l}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

/** Compact status chip used in the flat list view. */
function StatusPill({ status }: { status: TaskStatus }) {
  const m = STATUS_META[status];
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px] text-muted-foreground">
      <span className="size-1.5 rounded-full" style={{ background: `hsl(${m.color})` }} />
      {m.title}
    </span>
  );
}

/** One row in the list view — closer to how GitHub renders an issue list. */
function TaskRow({ t }: { t: Task }) {
  const done = t.status === "done";
  const Title = t.url ? "a" : "span";
  return (
    <div className="flex items-center gap-3 rounded-md border bg-card px-3 py-2.5 hover:bg-accent/40">
      <Checkbox defaultChecked={done} />
      <Title
        {...(t.url ? { href: t.url, target: "_blank", rel: "noreferrer" } : {})}
        className={cn(
          "min-w-0 flex-1 truncate text-[13.5px] font-medium",
          done && "text-muted-foreground line-through",
          t.url && "hover:underline",
        )}
      >
        {t.title}
      </Title>
      <div className="hidden items-center gap-1.5 sm:flex">
        {t.priority === "high" && (
          <Badge variant="outline" className="border-destructive/40 px-1 py-0 text-[10px] text-destructive">
            High
          </Badge>
        )}
        {t.labels?.slice(0, 3).map((l) => (
          <Badge key={l} variant="outline" className="px-1 py-0 text-[10px] text-muted-foreground">
            {l}
          </Badge>
        ))}
        {t.due && (
          <span className="font-mono text-[11.5px] text-muted-foreground">
            {new Date(t.due).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </span>
        )}
      </div>
      <StatusPill status={t.status} />
      {t.assignee && <PersonAvatar name={t.assignee} size="xs" />}
    </div>
  );
}

/** Flat list view — open tasks first, then done. Matches GitHub's issue list. */
function TasksList({ tasks }: { tasks: Task[] }) {
  const ordered = [...tasks].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
  if (ordered.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-[13px] text-muted-foreground">No tasks.</div>
    );
  }
  return (
    <div className="flex max-w-3xl flex-col gap-1.5">
      {ordered.map((t) => (
        <TaskRow key={t.id} t={t} />
      ))}
    </div>
  );
}

/** Kanban board — most useful when issues carry status labels. */
function TasksBoard({ tasks }: { tasks: Task[] }) {
  const byStatus = (s: TaskStatus) => tasks.filter((t) => t.status === s);
  return (
    <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
      {STATUS_ORDER.map((status) => {
        const { title, color } = STATUS_META[status];
        const items = byStatus(status);
        return (
          <div key={status} className="flex flex-col gap-2 rounded-lg border bg-card p-3.5">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="size-2 rounded-full" style={{ background: `hsl(${color})` }} />
              <span className="text-[13.5px] font-semibold">{title}</span>
              <span className="font-mono text-xs text-muted-foreground">{items.length}</span>
            </div>
            {items.map((t) => (
              <TaskCard key={t.id} t={t} />
            ))}
            {items.length === 0 && <div className="rounded-md border border-dashed p-3 text-center text-[12px] text-muted-foreground">Nothing here</div>}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Inline create form (#6) — mirrors the calendar plugin's "New event" card:
 * title + target calendar (the personal root by default) + optional due date.
 * Owned tasks land via the same `/api/tasks` write the capability bridge uses,
 * so the folder-grant ACL applies server-side.
 */
function NewTaskForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  // "root" = the personal root calendar (no folder); real calendars use their `${spaceId}${path}` id.
  const [calendarId, setCalendarId] = useState("root");
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listCalendars().then((cals) => alive && setCalendars(cals));
    return () => {
      alive = false;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    try {
      const cal = calendars.find((c) => c.id === calendarId);
      await createTask({
        title: t,
        space: cal?.spaceId,
        path: cal?.path,
        due: due ? new Date(due).toISOString() : undefined,
      });
      onDone();
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg === "unauthorized" ? "Sign in to create tasks." : msg);
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="flex max-w-3xl flex-col gap-2.5 rounded-lg border bg-card p-3.5"
    >
      <div className="text-[13.5px] font-semibold">New task</div>
      <Input
        autoFocus
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          setError(null);
        }}
        placeholder="Task title"
        disabled={busy}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select value={calendarId} onValueChange={setCalendarId}>
          <SelectTrigger className="w-[160px]" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="root">My tasks</SelectItem>
            {calendars.map((cal) => (
              <SelectItem key={cal.id} value={cal.id}>
                {cal.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="date"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          disabled={busy}
          className="w-[150px]"
          aria-label="Due date"
        />
        <div className="flex-1" />
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy || !title.trim()}>
          {busy ? "Creating…" : "Create task"}
        </Button>
      </div>
      {error && <p className="text-[12.5px] text-destructive">{error}</p>}
    </form>
  );
}

/** Toggle between the flat list and the Kanban board. */
function ViewToggle({ value, onChange }: { value: "list" | "board"; onChange: (v: "list" | "board") => void }) {
  return (
    <div className="flex items-center rounded-md border p-0.5">
      {(["list", "board"] as const).map((v) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          title={v === "list" ? "List" : "Board"}
          className={cn(
            "grid size-7 place-items-center rounded-[5px] transition-colors",
            value === v ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon name={v === "list" ? "list" : "board"} size={15} />
        </button>
      ))}
    </div>
  );
}

export function TasksView() {
  const { tasks, source, loading } = useTasks();
  const refresh = usePluginDataRefresh();
  // List by default: GitHub issues are a flat open/closed list, so the board's
  // status columns are only meaningful when issues carry status labels.
  const [mode, setMode] = useState<"list" | "board">("list");
  const [creating, setCreating] = useState(false);
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center gap-2">
        <SourcePill source={source} />
        {loading && <span className="text-[12px] text-muted-foreground">Loading…</span>}
        <div className="flex-1" />
        <ViewToggle value={mode} onChange={setMode} />
        <Button size="sm" onClick={() => setCreating((v) => !v)}>
          <Icon name="plus" size={15} /> New task
        </Button>
      </div>
      {creating && (
        <NewTaskForm
          onDone={() => {
            setCreating(false);
            refresh(); // useTasks refetches, so the new task appears in list/board
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      {mode === "board" ? <TasksBoard tasks={tasks} /> : <TasksList tasks={tasks} />}
    </div>
  );
}
