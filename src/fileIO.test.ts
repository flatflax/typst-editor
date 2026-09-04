import { describe, expect, it } from "vitest";
import { basename, defaultFileName, spokeForPath, titleFor } from "./fileIO";

describe("spokeForPath", () => {
  it("selects the markdown spoke for .md and .markdown", () => {
    expect(spokeForPath("notes.md")).toBe("markdown");
    expect(spokeForPath("notes.markdown")).toBe("markdown");
    expect(spokeForPath("NOTES.MD")).toBe("markdown");
  });

  it("selects the typst spoke for .typ", () => {
    expect(spokeForPath("doc.typ")).toBe("typst");
  });

  it("defaults unknown or missing extensions to the typst spoke", () => {
    expect(spokeForPath("README")).toBe("typst");
    expect(spokeForPath("notes.txt")).toBe("typst");
  });

  it("handles Windows-style paths", () => {
    expect(spokeForPath("C:\\Users\\me\\notes.md")).toBe("markdown");
    expect(spokeForPath("C:\\Users\\me\\doc.typ")).toBe("typst");
  });
});

describe("defaultFileName", () => {
  it("picks an extension matching the spoke", () => {
    expect(defaultFileName("typst")).toBe("untitled.typ");
    expect(defaultFileName("markdown")).toBe("untitled.md");
  });
});

describe("basename", () => {
  it("strips a POSIX directory prefix", () => {
    expect(basename("/home/me/doc.typ")).toBe("doc.typ");
  });

  it("strips a Windows directory prefix", () => {
    expect(basename("C:\\Users\\me\\doc.typ")).toBe("doc.typ");
  });

  it("returns the whole string when there is no separator", () => {
    expect(basename("doc.typ")).toBe("doc.typ");
  });
});

describe("titleFor", () => {
  it("shows Untitled with no path", () => {
    expect(titleFor(null, false)).toBe("Untitled");
  });

  it("appends a dirty marker", () => {
    expect(titleFor(null, true)).toBe("Untitled •");
    expect(titleFor("/a/b/doc.typ", true)).toBe("doc.typ •");
  });

  it("shows a clean basename with no marker", () => {
    expect(titleFor("/a/b/doc.typ", false)).toBe("doc.typ");
  });
});
