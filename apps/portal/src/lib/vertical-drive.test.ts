/**
 * The `Link` parser, which is the one piece of the vertical read path that can be
 * wrong without anything looking wrong: return null too eagerly and a folder is
 * truncated at the platform's default page of 20, which renders as a smaller folder
 * rather than as an error.
 */
import { describe, expect, it } from "vitest";
import { nextLink } from "./vertical-drive";

const NEXT = "https://drive.example/api/folders/root/files?limit=200&cursor=01J8Z";

describe("nextLink", () => {
  it("reads the next page from the header the platform emits", () => {
    expect(nextLink(`<${NEXT}>; rel="next"`)).toBe(NEXT);
  });

  it("stops when there is no header — the walk is over", () => {
    expect(nextLink(null)).toBeNull();
    expect(nextLink("")).toBeNull();
  });

  it("ignores links that are not the next page", () => {
    expect(nextLink('<https://drive.example/api/x>; rel="prev"')).toBeNull();
    // `rel="nextish"` must not match `next`.
    expect(nextLink('<https://drive.example/api/x>; rel="nextish"')).toBeNull();
  });

  it("picks the next link out of several", () => {
    expect(
      nextLink(`<https://drive.example/api/first>; rel="first", <${NEXT}>; rel="next"`),
    ).toBe(NEXT);
  });

  it("tolerates an unquoted rel and extra whitespace", () => {
    expect(nextLink(`  <${NEXT}> ;  rel=next `)).toBe(NEXT);
  });

  it("tolerates other parameters beside rel", () => {
    expect(nextLink(`<${NEXT}>; rel="next"; title="More"`)).toBe(NEXT);
  });
});
