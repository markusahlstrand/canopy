/**
 * Scheduling store — calendars, events, tasks, and principals (#34).
 *
 * The design principle: scheduling data **reuses the drive's identity and
 * permission model** rather than inventing its own. A *calendar is a virtual
 * folder* (a row in `folders` with `kind='calendar'`), so sharing a calendar is
 * just a folder grant and every permission check routes through {@link pathRole}
 * exactly like files do. Events and tasks live in their own tables — never
 * `files` — so they don't appear in drive listings, but they carry the same
 * `tenant_id` (space) + `path` (calendar folder) coordinates, which means one
 * folder grant covers a folder's documents *and* its scheduling items.
 *
 * JSCalendar (RFC 8984) is the canonical record shape: the full object is stored
 * verbatim in the `jscal` column, with a handful of fields (title, start, due,
 * status, …) lifted into columns for indexed range/status queries. The flat
 * shapes the host plugins render ({@link CalendarEvent} / {@link Task} from
 * `@canopy/core`) are a *projection* produced at the read boundary.
 *
 * This store is runtime-agnostic ({@link Db} only) and does its own authorization
 * via the exported authz helpers, so it never needs the `FileService`'s private
 * internals.
 */

import {
  ROLE_RANK,
  folderObjectId,
  memberSpaceIds,
  pathRole,
  sharedFolders,
  writeTuple,
} from "./authz";
import type { Db } from "./db";
import { PermissionError } from "./files";
import { sha256hex } from "./hash";
import type { Caller } from "./files";
import type { Role } from "./types";

const enc = new TextEncoder();
const now = () => new Date().toISOString();
const etagOf = (jscal: unknown) => sha256hex(enc.encode(JSON.stringify(jscal)));

/** Normalize a calendar/folder path the same way the drive does (no leading/trailing slash). */
function normPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

/* ── public shapes ─────────────────────────────────────────────────────────── */

/** A calendar: a shareable virtual folder of scheduling items. */
export interface Calendar {
  /** Stable id = `${spaceId}${path}` (the folder object id). */
  id: string;
  spaceId: string;
  /** Virtual-folder path within the space (e.g. "Work"). "" is the implicit root calendar. */
  path: string;
  name: string;
  /** Accent color — an HSL triplet like "145 33% 36%", or null to inherit the space color. */
  color: string | null;
  /** The caller's effective role on this calendar (folder grant ∪ space membership). */
  role: Role;
  createdAt?: string;
}

export interface EventInput {
  spaceId: string;
  /** Calendar folder path; "" targets the space's root calendar. */
  path?: string;
  title: string;
  /** ISO 8601 (date or date-time). */
  start?: string | null;
  end?: string | null;
  allDay?: boolean;
  description?: string | null;
  location?: string | null;
  keywords?: string[];
  /** Extra JSCalendar properties merged into the stored object. */
  jscal?: Record<string, unknown>;
}

export interface EventRecord {
  id: string;
  spaceId: string;
  path: string;
  uid: string;
  title: string;
  start: string | null;
  end: string | null;
  allDay: boolean;
  description: string | null;
  location: string | null;
  keywords: string[];
  etag: string;
  createdAt: string;
  updatedAt: string;
}

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";

export interface TaskInput {
  spaceId: string;
  path?: string;
  title: string;
  status?: TaskStatus;
  progress?: number | null;
  start?: string | null;
  due?: string | null;
  priority?: "low" | "normal" | "high" | null;
  keywords?: string[];
  jscal?: Record<string, unknown>;
}

export interface TaskRecord {
  id: string;
  spaceId: string;
  path: string;
  uid: string;
  title: string;
  status: TaskStatus;
  progress: number | null;
  start: string | null;
  due: string | null;
  priority: string | null;
  keywords: string[];
  etag: string;
  createdAt: string;
  updatedAt: string;
}

export interface Range {
  from: string;
  to: string;
}

export interface Principal {
  id: string;
  spaceId: string | null;
  kind: string;
  sub: string | null;
  email: string | null;
  name: string | null;
}

/* ── row → shape mappers ───────────────────────────────────────────────────── */

interface EventRow {
  id: string;
  tenant_id: string;
  path: string;
  owner_id: string;
  uid: string;
  title: string;
  start: string | null;
  end: string | null;
  all_day: number;
  description: string | null;
  location: string | null;
  keywords: string | null;
  jscal: string;
  etag: string;
  created_at: string;
  updated_at: string;
}

const parseKeywords = (s: string | null): string[] => {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

function toEvent(r: EventRow): EventRecord {
  return {
    id: r.id,
    spaceId: r.tenant_id,
    path: r.path,
    uid: r.uid,
    title: r.title,
    start: r.start,
    end: r.end,
    allDay: r.all_day === 1,
    description: r.description,
    location: r.location,
    keywords: parseKeywords(r.keywords),
    etag: r.etag,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface TaskRow {
  id: string;
  tenant_id: string;
  path: string;
  owner_id: string;
  uid: string;
  title: string;
  status: string;
  progress: number | null;
  start: string | null;
  due: string | null;
  priority: string | null;
  keywords: string | null;
  jscal: string;
  etag: string;
  created_at: string;
  updated_at: string;
}

function toTask(r: TaskRow): TaskRecord {
  return {
    id: r.id,
    spaceId: r.tenant_id,
    path: r.path,
    uid: r.uid,
    title: r.title,
    status: (r.status as TaskStatus) ?? "todo",
    progress: r.progress,
    start: r.start,
    due: r.due,
    priority: r.priority,
    keywords: parseKeywords(r.keywords),
    etag: r.etag,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* ── the store ─────────────────────────────────────────────────────────────── */

export class SchedulingStore {
  constructor(private readonly db: Db) {}

  /** Throw unless the caller holds at least `required` on `path` in `spaceId`. */
  private async requirePath(caller: Caller, spaceId: string, path: string, required: Role): Promise<void> {
    const role = await pathRole(this.db, spaceId, normPath(path), caller.sub, caller.email ?? "");
    if (!role || ROLE_RANK[role] < ROLE_RANK[required]) throw new PermissionError();
  }

  /* ── calendars (= virtual folders) ──────────────────────────────────────── */

  /**
   * Create a calendar in a space: a `folders` row tagged `kind='calendar'` with a
   * display name + color. Idempotent on (space, path) — re-creating updates the
   * name/color. Requires editor on the target path.
   */
  async createCalendar(
    caller: Caller,
    input: { spaceId: string; name: string; path?: string; color?: string | null },
  ): Promise<Calendar> {
    const path = normPath(input.path ?? input.name);
    if (!path) throw new Error("calendar path required");
    await this.requirePath(caller, input.spaceId, path, "editor");
    await this.db.run(
      `INSERT INTO folders (space_id, path, created_at, name, color, kind)
         VALUES (?, ?, ?, ?, ?, 'calendar')
       ON CONFLICT(space_id, path) DO UPDATE SET name = excluded.name, color = excluded.color, kind = 'calendar'`,
      [input.spaceId, path, now(), input.name, input.color ?? null],
    );
    const role = (await pathRole(this.db, input.spaceId, path, caller.sub, caller.email ?? "")) ?? "viewer";
    return { id: folderObjectId(input.spaceId, path), spaceId: input.spaceId, path, name: input.name, color: input.color ?? null, role };
  }

  /**
   * Calendars the caller can see: every `kind='calendar'` folder in a space they
   * belong to, plus folders shared directly with them. Optionally scoped to one
   * space.
   */
  async listCalendars(caller: Caller, spaceId?: string): Promise<Calendar[]> {
    const spaceIds = spaceId ? [spaceId] : await memberSpaceIds(this.db, caller.sub);
    const out: Calendar[] = [];
    const seen = new Set<string>();

    for (const sid of spaceIds) {
      const rows = await this.db.all<{ space_id: string; path: string; name: string | null; color: string | null; created_at: string }>(
        `SELECT space_id, path, name, color, created_at FROM folders WHERE space_id = ? AND kind = 'calendar' ORDER BY name`,
        [sid],
      );
      for (const r of rows) {
        const role = await pathRole(this.db, r.space_id, r.path, caller.sub, caller.email ?? "");
        if (!role) continue;
        const id = folderObjectId(r.space_id, r.path);
        seen.add(id);
        out.push({ id, spaceId: r.space_id, path: r.path, name: r.name ?? r.path, color: r.color, role, createdAt: r.created_at });
      }
    }

    // Calendars shared directly with the caller (folder grants), even outside a
    // space they're a member of — "shared with me".
    if (!spaceId) {
      const shared = await sharedFolders(this.db, caller.sub);
      for (const s of shared) {
        const id = folderObjectId(s.spaceId, s.path);
        if (seen.has(id)) continue;
        const row = await this.db.first<{ name: string | null; color: string | null }>(
          `SELECT name, color FROM folders WHERE space_id = ? AND path = ? AND kind = 'calendar'`,
          [s.spaceId, s.path],
        );
        if (!row) continue; // shared folder that isn't a calendar
        seen.add(id);
        out.push({ id, spaceId: s.spaceId, path: s.path, name: row.name ?? s.path, color: row.color, role: s.role });
      }
    }
    return out;
  }

  /** Share a calendar (folder) with a person by email — a viewer/editor folder grant. */
  async shareCalendar(caller: Caller, spaceId: string, path: string, email: string, role: Role): Promise<void> {
    await this.requirePath(caller, spaceId, path, "owner");
    await writeTuple(this.db, {
      objectType: "folder",
      objectId: folderObjectId(spaceId, normPath(path)),
      relation: role,
      subjectType: "email",
      subjectId: email.trim().toLowerCase(),
    });
  }

  /* ── events ─────────────────────────────────────────────────────────────── */

  async createEvent(caller: Caller, input: EventInput): Promise<EventRecord> {
    const path = normPath(input.path ?? "");
    await this.requirePath(caller, input.spaceId, path, "editor");
    const id = crypto.randomUUID();
    const uid = `${id}@canopy`;
    const ts = now();
    const allDay = input.allDay ?? false;
    const jscal = {
      "@type": "Event",
      uid,
      title: input.title,
      start: input.start ?? undefined,
      ...(input.end ? { end: input.end } : {}),
      ...(allDay ? { showWithoutTime: true } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.location ? { locations: { l1: { name: input.location } } } : {}),
      ...(input.keywords?.length ? { keywords: Object.fromEntries(input.keywords.map((k) => [k, true])) } : {}),
      ...omit(input.jscal, EVENT_MANAGED_KEYS),
    };
    const etag = await etagOf(jscal);
    await this.db.run(
      `INSERT INTO events (id, tenant_id, path, owner_id, uid, title, start, end, all_day, description, location, keywords, jscal, etag, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, input.spaceId, path, caller.sub, uid, input.title, input.start ?? null, input.end ?? null,
        allDay ? 1 : 0, input.description ?? null, input.location ?? null,
        input.keywords?.length ? JSON.stringify(input.keywords) : null, JSON.stringify(jscal), etag, ts, ts,
      ],
    );
    return (await this.getEvent(caller, id))!;
  }

  async getEvent(caller: Caller, id: string): Promise<EventRecord | null> {
    const row = await this.db.first<EventRow>(`SELECT * FROM events WHERE id = ? AND deleted_at IS NULL`, [id]);
    if (!row) return null;
    await this.requirePath(caller, row.tenant_id, row.path, "viewer");
    return toEvent(row);
  }

  /**
   * Events the caller can see in `[from, to)`. Without `spaceId` it spans every
   * space the caller belongs to; `calendars` (paths) narrows to specific calendars.
   */
  async listEvents(
    caller: Caller,
    opts: { range: Range; spaceId?: string; calendars?: string[] },
  ): Promise<(EventRecord & { role: Role })[]> {
    const spaceIds = await this.aggregateSpaceIds(caller, opts.spaceId);
    const out: (EventRecord & { role: Role })[] = [];
    for (const sid of spaceIds) {
      const rows = await this.db.all<EventRow>(
        // Ranged events (end set) overlap the window; point-in-time events (end
        // NULL) match only when their start itself falls in [from, to). Undated
        // events always surface.
        `SELECT * FROM events
           WHERE tenant_id = ? AND deleted_at IS NULL
             AND (start IS NULL
                  OR (end IS NOT NULL AND start < ? AND end >= ?)
                  OR (end IS NULL AND start >= ? AND start < ?))
           ORDER BY start`,
        [sid, opts.range.to, opts.range.from, opts.range.from, opts.range.to],
      );
      for (const r of rows) {
        if (opts.calendars && !opts.calendars.includes(r.path)) continue;
        const role = await pathRole(this.db, r.tenant_id, r.path, caller.sub, caller.email ?? "");
        if (!role) continue;
        out.push({ ...toEvent(r), role });
      }
    }
    return out.sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
  }

  /**
   * Spaces to scan for an aggregate read: every space the caller belongs to, plus
   * spaces reachable only through a direct folder share (calendars shared with the
   * caller who isn't a member). Scoped to one space when `spaceId` is given.
   */
  private async aggregateSpaceIds(caller: Caller, spaceId?: string): Promise<string[]> {
    if (spaceId) return [spaceId];
    const member = await memberSpaceIds(this.db, caller.sub);
    const shared = await sharedFolders(this.db, caller.sub);
    return [...new Set([...member, ...shared.map((s) => s.spaceId)])];
  }

  async updateEvent(caller: Caller, id: string, patch: Partial<EventInput>): Promise<EventRecord> {
    const row = await this.db.first<EventRow>(`SELECT * FROM events WHERE id = ? AND deleted_at IS NULL`, [id]);
    if (!row) throw new Error("event not found");
    await this.requirePath(caller, row.tenant_id, row.path, "editor");
    const merged: EventRecord = { ...toEvent(row), ...stripUndefined(patch) } as EventRecord;
    const jscal = { ...(JSON.parse(row.jscal) as Record<string, unknown>) };
    if (patch.title !== undefined) jscal.title = patch.title;
    if (patch.start !== undefined) jscal.start = patch.start ?? undefined;
    if (patch.end !== undefined) jscal.end = patch.end ?? undefined;
    if (patch.description !== undefined) jscal.description = patch.description ?? undefined;
    if (patch.location !== undefined)
      jscal.locations = patch.location ? { l1: { name: patch.location } } : undefined;
    if (patch.allDay !== undefined) jscal.showWithoutTime = patch.allDay ? true : undefined;
    if (patch.keywords !== undefined)
      jscal.keywords = patch.keywords?.length ? Object.fromEntries(patch.keywords.map((k) => [k, true])) : undefined;
    const etag = await etagOf(jscal);
    const allDay = patch.allDay ?? merged.allDay;
    await this.db.run(
      `UPDATE events SET title = ?, start = ?, end = ?, all_day = ?, description = ?, location = ?, keywords = ?, jscal = ?, etag = ?, updated_at = ?
         WHERE id = ?`,
      [
        merged.title, merged.start ?? null, merged.end ?? null, allDay ? 1 : 0, merged.description ?? null,
        merged.location ?? null, merged.keywords.length ? JSON.stringify(merged.keywords) : null,
        JSON.stringify(jscal), etag, now(), id,
      ],
    );
    return (await this.getEvent(caller, id))!;
  }

  async deleteEvent(caller: Caller, id: string): Promise<void> {
    const row = await this.db.first<EventRow>(`SELECT tenant_id, path FROM events WHERE id = ? AND deleted_at IS NULL`, [id]);
    if (!row) return;
    await this.requirePath(caller, row.tenant_id, row.path, "editor");
    await this.db.run(`UPDATE events SET deleted_at = ? WHERE id = ?`, [now(), id]);
  }

  /* ── tasks ──────────────────────────────────────────────────────────────── */

  async createTask(caller: Caller, input: TaskInput): Promise<TaskRecord> {
    const path = normPath(input.path ?? "");
    await this.requirePath(caller, input.spaceId, path, "editor");
    const id = crypto.randomUUID();
    const uid = `${id}@canopy`;
    const ts = now();
    const status = input.status ?? "todo";
    const jscal = {
      "@type": "Task",
      uid,
      title: input.title,
      progress: status === "done" ? "completed" : status === "in_progress" ? "in-process" : "needs-action",
      ...(input.progress != null ? { percentComplete: input.progress } : {}),
      ...(input.start ? { start: input.start } : {}),
      ...(input.due ? { due: input.due } : {}),
      ...(input.keywords?.length ? { keywords: Object.fromEntries(input.keywords.map((k) => [k, true])) } : {}),
      ...omit(input.jscal, TASK_MANAGED_KEYS),
    };
    const etag = await etagOf(jscal);
    await this.db.run(
      `INSERT INTO tasks (id, tenant_id, path, owner_id, uid, title, status, progress, start, due, priority, keywords, jscal, etag, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, input.spaceId, path, caller.sub, uid, input.title, status, input.progress ?? null,
        input.start ?? null, input.due ?? null, input.priority ?? null,
        input.keywords?.length ? JSON.stringify(input.keywords) : null, JSON.stringify(jscal), etag, ts, ts,
      ],
    );
    return (await this.getTask(caller, id))!;
  }

  async getTask(caller: Caller, id: string): Promise<TaskRecord | null> {
    const row = await this.db.first<TaskRow>(`SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL`, [id]);
    if (!row) return null;
    await this.requirePath(caller, row.tenant_id, row.path, "viewer");
    return toTask(row);
  }

  async listTasks(
    caller: Caller,
    opts: { spaceId?: string; calendars?: string[] } = {},
  ): Promise<(TaskRecord & { role: Role })[]> {
    const spaceIds = await this.aggregateSpaceIds(caller, opts.spaceId);
    const out: (TaskRecord & { role: Role })[] = [];
    for (const sid of spaceIds) {
      const rows = await this.db.all<TaskRow>(
        `SELECT * FROM tasks WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY due`,
        [sid],
      );
      for (const r of rows) {
        if (opts.calendars && !opts.calendars.includes(r.path)) continue;
        const role = await pathRole(this.db, r.tenant_id, r.path, caller.sub, caller.email ?? "");
        if (!role) continue;
        out.push({ ...toTask(r), role });
      }
    }
    return out;
  }

  async updateTask(caller: Caller, id: string, patch: Partial<TaskInput>): Promise<TaskRecord> {
    const row = await this.db.first<TaskRow>(`SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL`, [id]);
    if (!row) throw new Error("task not found");
    await this.requirePath(caller, row.tenant_id, row.path, "editor");
    const merged: TaskRecord = { ...toTask(row), ...stripUndefined(patch) } as TaskRecord;
    const jscal = { ...(JSON.parse(row.jscal) as Record<string, unknown>) };
    if (patch.title !== undefined) jscal.title = patch.title;
    if (patch.status !== undefined)
      jscal.progress = patch.status === "done" ? "completed" : patch.status === "in_progress" ? "in-process" : "needs-action";
    if (patch.progress !== undefined) jscal.percentComplete = patch.progress ?? undefined;
    if (patch.start !== undefined) jscal.start = patch.start ?? undefined;
    if (patch.due !== undefined) jscal.due = patch.due ?? undefined;
    if (patch.keywords !== undefined)
      jscal.keywords = patch.keywords?.length ? Object.fromEntries(patch.keywords.map((k) => [k, true])) : undefined;
    const etag = await etagOf(jscal);
    await this.db.run(
      `UPDATE tasks SET title = ?, status = ?, progress = ?, start = ?, due = ?, priority = ?, keywords = ?, jscal = ?, etag = ?, updated_at = ?
         WHERE id = ?`,
      [
        merged.title, merged.status, merged.progress ?? null, merged.start ?? null, merged.due ?? null,
        merged.priority ?? null, merged.keywords.length ? JSON.stringify(merged.keywords) : null,
        JSON.stringify(jscal), etag, now(), id,
      ],
    );
    return (await this.getTask(caller, id))!;
  }

  async deleteTask(caller: Caller, id: string): Promise<void> {
    const row = await this.db.first<TaskRow>(`SELECT tenant_id, path FROM tasks WHERE id = ? AND deleted_at IS NULL`, [id]);
    if (!row) return;
    await this.requirePath(caller, row.tenant_id, row.path, "editor");
    await this.db.run(`UPDATE tasks SET deleted_at = ? WHERE id = ?`, [now(), id]);
  }

  /* ── principals + participants ──────────────────────────────────────────── */

  /** Find or create a person principal (by email within a space). */
  async upsertPrincipal(
    caller: Caller,
    input: { spaceId: string; email?: string; name?: string; sub?: string },
  ): Promise<Principal> {
    await this.requirePath(caller, input.spaceId, "", "editor");
    const email = input.email?.trim().toLowerCase() ?? null;
    if (email) {
      const existing = await this.db.first<{ id: string; sub: string | null; name: string | null }>(
        `SELECT id, sub, name FROM principals WHERE tenant_id = ? AND email = ? AND kind = 'person'`,
        [input.spaceId, email],
      );
      if (existing)
        return { id: existing.id, spaceId: input.spaceId, kind: "person", sub: existing.sub, email, name: existing.name };
    }
    const id = crypto.randomUUID();
    await this.db.run(
      `INSERT INTO principals (id, tenant_id, kind, sub, email, name, created_at) VALUES (?, ?, 'person', ?, ?, ?, ?)`,
      [id, input.spaceId, input.sub ?? null, email, input.name ?? null, now()],
    );
    return { id, spaceId: input.spaceId, kind: "person", sub: input.sub ?? null, email, name: input.name ?? null };
  }

  /** Attach a principal to an event as a participant. */
  async addParticipant(
    caller: Caller,
    eventId: string,
    principalId: string,
    opts: { role?: string; status?: string } = {},
  ): Promise<void> {
    const ev = await this.db.first<{ tenant_id: string; path: string }>(
      `SELECT tenant_id, path FROM events WHERE id = ? AND deleted_at IS NULL`,
      [eventId],
    );
    if (!ev) throw new Error("event not found");
    await this.requirePath(caller, ev.tenant_id, ev.path, "editor");
    // The principal must belong to the event's space — otherwise listParticipants
    // could surface a cross-tenant person's email/name.
    const principal = await this.db.first<{ tenant_id: string | null }>(
      `SELECT tenant_id FROM principals WHERE id = ?`,
      [principalId],
    );
    if (!principal) throw new Error("principal not found");
    if (principal.tenant_id !== ev.tenant_id) throw new PermissionError();
    await this.db.run(
      `INSERT INTO event_participants (event_id, principal_id, role, status) VALUES (?, ?, ?, ?)
         ON CONFLICT(event_id, principal_id) DO UPDATE SET role = excluded.role, status = excluded.status`,
      [eventId, principalId, opts.role ?? "attendee", opts.status ?? "needs-action"],
    );
  }

  async listParticipants(caller: Caller, eventId: string): Promise<Principal[]> {
    const ev = await this.db.first<{ tenant_id: string; path: string }>(
      `SELECT tenant_id, path FROM events WHERE id = ? AND deleted_at IS NULL`,
      [eventId],
    );
    if (!ev) return [];
    await this.requirePath(caller, ev.tenant_id, ev.path, "viewer");
    return this.db.all<Principal>(
      `SELECT p.id, p.tenant_id AS spaceId, p.kind, p.sub, p.email, p.name
         FROM event_participants ep JOIN principals p ON p.id = ep.principal_id
        WHERE ep.event_id = ?`,
      [eventId],
    );
  }
}

/** Drop keys whose value is `undefined` so a partial patch doesn't clobber with undefined. */
function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Keys the store manages itself in the canonical JSCalendar object (identity +
 * indexed columns). User-supplied `input.jscal` must not override these, or the
 * `jscal` payload would drift from the indexed columns. Anything else in
 * `input.jscal` is kept as a user extension.
 */
const EVENT_MANAGED_KEYS = ["@type", "uid", "title", "start", "end", "showWithoutTime", "description", "locations", "keywords"];
const TASK_MANAGED_KEYS = ["@type", "uid", "title", "progress", "percentComplete", "start", "due", "keywords"];

function omit(obj: Record<string, unknown> | undefined, keys: string[]): Record<string, unknown> {
  if (!obj) return {};
  const drop = new Set(keys);
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !drop.has(k)));
}
