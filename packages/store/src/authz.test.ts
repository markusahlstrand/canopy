import { beforeEach, describe, expect, it } from "vitest";
import { createLibsqlDb } from "./db-libsql";
import { runMigrations } from "./schema";
import { check, fileRole, memberSpaceIds, spaceRole, writeTuple } from "./authz";
import { addMember, createSpace, ensurePersonalSpace, listMembers, listSpaces, listSpacesForUser, removeMember, setMounted } from "./spaces";
import { resolveInvites, upsertUser } from "./users";
import type { Db } from "./db";

/** Integration: the recursive Zanzibar-lite check against a real libsql engine. */

let db: Db;
beforeEach(async () => {
  db = createLibsqlDb(":memory:");
  await runMigrations(db);
});

describe("relation-tuple check", () => {
  it("direct grant respects the role hierarchy (owner ⊇ editor ⊇ viewer)", async () => {
    await writeTuple(db, { objectType: "file", objectId: "F1", relation: "editor", subjectType: "user", subjectId: "maya" });
    expect(await fileRole(db, "F1", "maya")).toBe("editor");
    expect(await check(db, { objectType: "file", objectId: "F1", required: "viewer", userSub: "maya" })).toBe(true);
    expect(await check(db, { objectType: "file", objectId: "F1", required: "editor", userSub: "maya" })).toBe(true);
    expect(await check(db, { objectType: "file", objectId: "F1", required: "owner", userSub: "maya" })).toBe(false);
    expect(await fileRole(db, "F1", "stranger")).toBeNull();
  });

  it("members of a file's space inherit their space role on the file (tuple-to-userset)", async () => {
    // F2 lives in space S; maya is an editor of S.
    await writeTuple(db, { objectType: "file", objectId: "F2", relation: "space", subjectType: "space", subjectId: "S" });
    await writeTuple(db, { objectType: "space", objectId: "S", relation: "editor", subjectType: "user", subjectId: "maya" });
    expect(await fileRole(db, "F2", "maya")).toBe("editor");
    expect(await fileRole(db, "F2", "daniel")).toBeNull();
  });

  it("a file shared with space#member grants every member (regardless of their space role)", async () => {
    // F3 shared as viewer to the whole family; daniel is only a viewer of the family.
    await writeTuple(db, { objectType: "file", objectId: "F3", relation: "viewer", subjectType: "space", subjectId: "fam", subjectRelation: "member" });
    await writeTuple(db, { objectType: "space", objectId: "fam", relation: "viewer", subjectType: "user", subjectId: "daniel" });
    expect(await fileRole(db, "F3", "daniel")).toBe("viewer");
    expect(await fileRole(db, "F3", "outsider")).toBeNull();
  });

  it("nested groups resolve recursively", async () => {
    // family includes the "cousins" group's members; lily is in cousins.
    await writeTuple(db, { objectType: "space", objectId: "fam", relation: "viewer", subjectType: "space", subjectId: "cousins", subjectRelation: "member" });
    await writeTuple(db, { objectType: "space", objectId: "cousins", relation: "viewer", subjectType: "user", subjectId: "lily" });
    // F4 shared with the family as editor.
    await writeTuple(db, { objectType: "file", objectId: "F4", relation: "editor", subjectType: "space", subjectId: "fam", subjectRelation: "member" });
    expect(await memberSpaceIds(db, "lily")).toEqual(expect.arrayContaining(["cousins", "fam"]));
    expect(await fileRole(db, "F4", "lily")).toBe("editor");
  });

  it("email grants match a pending invite", async () => {
    await writeTuple(db, { objectType: "file", objectId: "F5", relation: "viewer", subjectType: "email", subjectId: "nora@x.com" });
    expect(await fileRole(db, "F5", "whatever-sub", "nora@x.com")).toBe("viewer");
    expect(await fileRole(db, "F5", "whatever-sub", "someone@else.com")).toBeNull();
  });

  it("takes the MAX across multiple grant paths", async () => {
    // viewer via space, but also a direct editor grant → editor wins.
    await writeTuple(db, { objectType: "file", objectId: "F6", relation: "space", subjectType: "space", subjectId: "S6" });
    await writeTuple(db, { objectType: "space", objectId: "S6", relation: "viewer", subjectType: "user", subjectId: "maya" });
    await writeTuple(db, { objectType: "file", objectId: "F6", relation: "editor", subjectType: "user", subjectId: "maya" });
    expect(await fileRole(db, "F6", "maya")).toBe("editor");
  });
});

describe("spaces helpers", () => {
  it("ensurePersonalSpace makes the user its owner (idempotent)", async () => {
    const id = await ensurePersonalSpace(db, "maya");
    const again = await ensurePersonalSpace(db, "maya");
    expect(again).toBe(id);
    expect(await spaceRole(db, id, "maya")).toBe("owner");
  });

  it("createSpace + addMember + listSpaces", async () => {
    await ensurePersonalSpace(db, "maya");
    const fam = await createSpace(db, { name: "Family", createdBy: "maya" });
    await addMember(db, fam.id, "daniel", "editor");

    expect(await spaceRole(db, fam.id, "maya")).toBe("owner");
    expect(await spaceRole(db, fam.id, "daniel")).toBe("editor");
    expect(await spaceRole(db, fam.id, "stranger")).toBeNull();

    const mayaSpaces = (await listSpaces(db, "maya")).map((s) => s.name).sort();
    expect(mayaSpaces).toEqual(["Family", "My Drive"]);
    expect((await listSpaces(db, "daniel")).map((s) => s.name)).toEqual(["Family"]);
  });

  it("listMembers joins the directory; removeMember revokes", async () => {
    const fam = await createSpace(db, { name: "Family", createdBy: "maya" });
    await upsertUser(db, { sub: "daniel", email: "daniel@x.com", name: "Daniel" });
    await addMember(db, fam.id, "daniel", "editor");

    const members = await listMembers(db, fam.id);
    expect(members.find((m) => m.sub === "maya")?.role).toBe("owner");
    const daniel = members.find((m) => m.sub === "daniel");
    expect(daniel).toMatchObject({ role: "editor", email: "daniel@x.com", name: "Daniel" });

    await removeMember(db, fam.id, "daniel");
    expect(await spaceRole(db, fam.id, "daniel")).toBeNull();
  });

  it("mount preference defaults to true and toggles per user", async () => {
    await ensurePersonalSpace(db, "maya");
    const fam = await createSpace(db, { name: "Family", createdBy: "maya" });

    const before = await listSpacesForUser(db, "maya");
    expect(before.find((s) => s.kind === "personal")?.mounted).toBe(true);
    expect(before.find((s) => s.id === fam.id)?.mounted).toBe(true); // default
    expect(before.find((s) => s.id === fam.id)?.role).toBe("owner");

    await setMounted(db, "maya", fam.id, false);
    const after = await listSpacesForUser(db, "maya");
    expect(after.find((s) => s.id === fam.id)?.mounted).toBe(false);
  });

  it("resolveInvites turns a pending email grant into a user grant on login", async () => {
    await writeTuple(db, { objectType: "file", objectId: "F9", relation: "viewer", subjectType: "email", subjectId: "nora@x.com" });
    expect(await fileRole(db, "F9", "nora-sub")).toBeNull(); // not yet, by sub

    await resolveInvites(db, "nora-sub", "nora@x.com");
    expect(await fileRole(db, "F9", "nora-sub")).toBe("viewer"); // now a user grant
    expect(await fileRole(db, "F9", "x", "nora@x.com")).toBeNull(); // email tuple gone
  });
});
