import { describe, expect, it } from "vitest";
import {
  basename,
  defaultFileName,
  dirname,
  relativePath,
  spokeForPath,
  titleFor,
  withPdfExtension,
} from "./fileIO";

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

describe("dirname (plan.md M11)", () => {
  it("returns null with no open file", () => {
    expect(dirname(null)).toBeNull();
  });

  it("strips a POSIX filename", () => {
    expect(dirname("/home/me/docs/doc.typ")).toBe("/home/me/docs");
  });

  it("strips a Windows filename", () => {
    expect(dirname("C:\\Users\\me\\doc.typ")).toBe("C:/Users/me");
  });

  it("returns / for a file at the filesystem root", () => {
    expect(dirname("/doc.typ")).toBe("/");
  });

  it("returns null for a bare filename with no directory info", () => {
    expect(dirname("doc.typ")).toBeNull();
  });
});

describe("relativePath (plan.md M11)", () => {
  it("returns just the filename when it's already in fromDir", () => {
    expect(relativePath("/home/me/docs", "/home/me/docs/photo.png")).toBe("photo.png");
  });

  it("descends into a subdirectory", () => {
    expect(relativePath("/home/me/docs", "/home/me/docs/images/photo.png")).toBe(
      "images/photo.png",
    );
  });

  it("climbs up with .. for a sibling directory", () => {
    expect(relativePath("/home/me/docs", "/home/me/assets/photo.png")).toBe("../assets/photo.png");
  });

  it("handles Windows-style paths case-insensitively", () => {
    expect(relativePath("C:\\Users\\me\\Docs", "C:\\Users\\me\\docs\\photo.png")).toBe("photo.png");
    expect(relativePath("C:\\Users\\me\\docs", "C:\\Users\\me\\assets\\photo.png")).toBe(
      "../assets/photo.png",
    );
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

describe("withPdfExtension", () => {
  it("defaults to document.pdf with no open file", () => {
    expect(withPdfExtension(null)).toBe("document.pdf");
  });

  it("swaps the extension while keeping the directory", () => {
    expect(withPdfExtension("/a/b/doc.typ")).toBe("/a/b/doc.pdf");
    expect(withPdfExtension("notes.md")).toBe("notes.pdf");
  });

  it("handles Windows-style paths", () => {
    expect(withPdfExtension("C:\\Users\\me\\doc.typ")).toBe("C:/Users/me/doc.pdf");
  });
});
