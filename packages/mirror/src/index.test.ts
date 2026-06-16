import { describe, expect, it } from "vitest";
import { applyDelta, folderView, maxSeq, normPath, subfolders, type MirrorChange, type MirrorFile } from "./index";

function file(id: string, path: string, name: string, extra: Partial<MirrorFile> = {}): MirrorFile {
  return { id, spaceId: "s1", name, path, metadata: {}, updatedAt: "", seq: 1, size: null, mime: null, ...extra };
}

describe("normPath", () => {
  it("trims slashes and drops empty/dot segments", () => {
    expect(normPath("/A//B/./C/")).toBe("A/B/C");
    expect(normPath("")).toBe("");
    expect(normPath("  Docs  /  2026 ")).toBe("Docs/2026");
  });
});

describe("subfolders", () => {
  it("derives immediate child folder names of a dir", () => {
    const paths = ["", "A", "A/B", "A/B/C", "D"];
    expect(subfolders("", paths)).toEqual(["A", "D"]);
    expect(subfolders("A", paths)).toEqual(["B"]);
    expect(subfolders("A/B", paths)).toEqual(["C"]);
  });
});

describe("folderView", () => {
  const rows = [
    file("f1", "", "zeta.md"),
    file("f2", "", "alpha.md"),
    file("f3", "Docs", "inside.md"),
    file("f4", "Docs/2026", "deep.md"),
  ];

  it("returns files directly in the dir, sorted by name, plus immediate subfolders", () => {
    const view = folderView(rows, "");
    expect(view.files.map((f) => f.name)).toEqual(["alpha.md", "zeta.md"]);
    expect(view.folders).toEqual(["Docs"]);
  });

  it("descends into a subfolder", () => {
    const view = folderView(rows, "Docs");
    expect(view.files.map((f) => f.id)).toEqual(["f3"]);
    expect(view.folders).toEqual(["2026"]);
  });

  it("normalizes the requested dir", () => {
    expect(folderView(rows, "/Docs/").files.map((f) => f.id)).toEqual(["f3"]);
  });
});

describe("applyDelta", () => {
  it("upserts live rows and removes tombstones", () => {
    const byId = new Map<string, MirrorFile>();
    const changes: MirrorChange[] = [
      file("f1", "", "a.md", { seq: 5 }),
      file("f2", "", "b.md", { seq: 6 }),
    ];
    applyDelta(byId, changes);
    expect([...byId.keys()].sort()).toEqual(["f1", "f2"]);

    // A later delta updates f1 and tombstones f2.
    applyDelta(byId, [
      file("f1", "Docs", "a.md", { seq: 9 }),
      { id: "f2", spaceId: "s1", seq: 10, deleted: true },
    ]);
    expect(byId.get("f1")?.path).toBe("Docs");
    expect(byId.has("f2")).toBe(false);
  });

  it("strips the deleted:false discriminator off a live row when storing", () => {
    const byId = new Map<string, MirrorFile>();
    applyDelta(byId, [{ ...file("f1", "", "a.md"), deleted: false }]);
    expect(byId.get("f1")).not.toHaveProperty("deleted");
  });
});

describe("maxSeq", () => {
  it("returns the highest seq, 0 when empty", () => {
    expect(maxSeq([])).toBe(0);
    expect(maxSeq([file("f1", "", "a", { seq: 3 }), { id: "f2", spaceId: "s1", seq: 8, deleted: true }])).toBe(8);
  });
});
