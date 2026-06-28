import { beforeEach, describe, expect, it } from "vitest";
import { createLibsqlDb } from "./db-libsql";
import { runMigrations } from "./schema";
import { PermissionError } from "./files";
import { addMember, createSpace, ensurePersonalSpace } from "./spaces";
import { upsertUser } from "./users";
import { SchedulingStore } from "./scheduling";
import type { Db } from "./db";

let db: Db;
let store: SchedulingStore;
const maya = { sub: "maya", email: "maya@x.com" };
const daniel = { sub: "daniel", email: "daniel@x.com" };
let personal: string;

beforeEach(async () => {
  db = createLibsqlDb(":memory:");
  await runMigrations(db);
  await upsertUser(db, { sub: "maya", email: "maya@x.com" });
  await upsertUser(db, { sub: "daniel", email: "daniel@x.com" });
  personal = await ensurePersonalSpace(db, "maya");
  store = new SchedulingStore(db);
});

describe("calendars (= virtual folders)", () => {
  it("creates a calendar and lists it back", async () => {
    const cal = await store.createCalendar(maya, { spaceId: personal, name: "Work", color: "212 92% 50%" });
    expect(cal.path).toBe("Work");
    expect(cal.name).toBe("Work");
    expect(cal.role).toBe("owner");
    const list = await store.listCalendars(maya, personal);
    expect(list.map((c) => c.name)).toContain("Work");
  });

  it("re-creating a calendar updates name/color (idempotent on path)", async () => {
    await store.createCalendar(maya, { spaceId: personal, name: "Work", path: "work" });
    await store.createCalendar(maya, { spaceId: personal, name: "Job", path: "work", color: "0 0% 0%" });
    const list = await store.listCalendars(maya, personal);
    const work = list.find((c) => c.path === "work")!;
    expect(work.name).toBe("Job");
    expect(work.color).toBe("0 0% 0%");
  });
});

describe("events", () => {
  it("creates an event in a calendar and finds it in range", async () => {
    await store.createCalendar(maya, { spaceId: personal, name: "Work", path: "work" });
    const ev = await store.createEvent(maya, {
      spaceId: personal,
      path: "work",
      title: "Standup",
      start: "2026-07-01T09:00:00Z",
      end: "2026-07-01T09:30:00Z",
    });
    expect(ev.title).toBe("Standup");
    expect(ev.etag).toMatch(/^[0-9a-f]{64}$/);
    const inRange = await store.listEvents(maya, {
      spaceId: personal,
      range: { from: "2026-07-01T00:00:00Z", to: "2026-07-02T00:00:00Z" },
    });
    expect(inRange.map((e) => e.id)).toContain(ev.id);
    const outOfRange = await store.listEvents(maya, {
      spaceId: personal,
      range: { from: "2026-08-01T00:00:00Z", to: "2026-08-02T00:00:00Z" },
    });
    expect(outOfRange.map((e) => e.id)).not.toContain(ev.id);
  });

  it("updates and soft-deletes an event", async () => {
    const ev = await store.createEvent(maya, { spaceId: personal, path: "", title: "Draft", start: "2026-07-01T09:00:00Z" });
    const updated = await store.updateEvent(maya, ev.id, { title: "Final" });
    expect(updated.title).toBe("Final");
    expect(updated.etag).not.toBe(ev.etag);
    await store.deleteEvent(maya, ev.id);
    expect(await store.getEvent(maya, ev.id)).toBeNull();
  });
});

describe("tasks", () => {
  it("creates and completes a task", async () => {
    const t = await store.createTask(maya, { spaceId: personal, title: "Ship it", due: "2026-07-05" });
    expect(t.status).toBe("todo");
    const done = await store.updateTask(maya, t.id, { status: "done", progress: 100 });
    expect(done.status).toBe("done");
    expect(done.progress).toBe(100);
    const list = await store.listTasks(maya, { spaceId: personal });
    expect(list.map((x) => x.id)).toContain(t.id);
  });
});

describe("permissions reuse folder grants", () => {
  it("a non-member cannot read another user's calendar", async () => {
    await store.createCalendar(maya, { spaceId: personal, name: "Private", path: "private" });
    const ev = await store.createEvent(maya, { spaceId: personal, path: "private", title: "Secret", start: "2026-07-01T09:00:00Z" });
    await expect(store.getEvent(daniel, ev.id)).rejects.toBeInstanceOf(PermissionError);
    const danielSees = await store.listEvents(daniel, {
      spaceId: personal,
      range: { from: "2026-07-01T00:00:00Z", to: "2026-07-02T00:00:00Z" },
    });
    expect(danielSees).toHaveLength(0);
  });

  it("sharing a calendar folder grants a person access to its events", async () => {
    await store.createCalendar(maya, { spaceId: personal, name: "Family", path: "family" });
    const ev = await store.createEvent(maya, { spaceId: personal, path: "family", title: "Dinner", start: "2026-07-01T18:00:00Z" });
    await store.shareCalendar(maya, personal, "family", "daniel@x.com", "viewer");
    const seen = await store.getEvent(daniel, ev.id);
    expect(seen?.title).toBe("Dinner");
  });

  it("group-space members see a space calendar's events", async () => {
    const fam = await createSpace(db, { name: "Household", createdBy: "maya" });
    // Add daniel as an editor of the group space.
    await addMember(db, fam.id, "daniel", "editor");
    await store.createCalendar(maya, { spaceId: fam.id, name: "Shared", path: "shared" });
    const ev = await store.createEvent(maya, { spaceId: fam.id, path: "shared", title: "Cleanup", start: "2026-07-01T10:00:00Z" });
    const seen = await store.getEvent(daniel, ev.id);
    expect(seen?.id).toBe(ev.id);
  });
});

describe("participants", () => {
  it("attaches a principal to an event", async () => {
    const ev = await store.createEvent(maya, { spaceId: personal, path: "", title: "Sync", start: "2026-07-01T09:00:00Z" });
    const p = await store.upsertPrincipal(maya, { spaceId: personal, email: "guest@x.com", name: "Guest" });
    await store.addParticipant(maya, ev.id, p.id, { role: "attendee" });
    const parts = await store.listParticipants(maya, ev.id);
    expect(parts.map((x) => x.email)).toContain("guest@x.com");
  });
});
