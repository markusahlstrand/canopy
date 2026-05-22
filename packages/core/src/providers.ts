/**
 * Data providers — typed, trusted, server-side sources that feed host plugins
 * (tasks, calendar) the same way a StorageConnector feeds the drive. A provider
 * normalizes some external system (GitHub issues, an ICS feed, Google Calendar)
 * into the shapes below; the host plugins render them and never learn where the
 * data came from. This is the "data adapter" sibling of StorageConnector.
 */

/** A normalized calendar entry. Times are ISO 8601; all-day events omit `end`. */
export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO 8601 start (date or date-time). */
  start: string;
  /** ISO 8601 end; omit for all-day / point-in-time events. */
  end?: string;
  allDay?: boolean;
  /** Coarse classification used for tinting and grouping. */
  kind?: "milestone" | "release" | "issue" | "event";
  /** Deep link back to the source (e.g. the GitHub release URL). */
  url?: string;
  /** Optional accent token (matches the host's TONE_COLOR keys). */
  tone?: string;
}

export interface CalendarRange {
  /** ISO 8601 inclusive lower bound. */
  from: string;
  /** ISO 8601 exclusive upper bound. */
  to: string;
}

export interface CalendarProvider {
  /** Provider instance id (e.g. "github"). */
  readonly id: string;
  listEvents(range: CalendarRange): Promise<CalendarEvent[]>;
}

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";

/** A normalized task / work item. */
export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  /** Display name or handle of the assignee. */
  assignee?: string;
  /** ISO 8601 due date, if any. */
  due?: string;
  labels?: string[];
  priority?: "low" | "normal" | "high";
  /** Deep link back to the source (e.g. the GitHub issue URL). */
  url?: string;
}

export interface TaskProvider {
  /** Provider instance id (e.g. "github"). */
  readonly id: string;
  listTasks(): Promise<Task[]>;
}

/** Stable display order + labels for the four task statuses. */
export const TASK_STATUS_ORDER: TaskStatus[] = ["todo", "in_progress", "blocked", "done"];
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
};
