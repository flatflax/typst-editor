import { describe, expect, it } from "vitest";
import { utf16ToByteOffset } from "../util/offsets";
import { blockAt, blockByteRanges } from "./blockSplit";

// Reads a byte range back out as a UTF-16 substring, for readable assertions.
function textOf(source: string, range: [number, number]): string {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const bytes = enc.encode(source);
  return dec.decode(bytes.subarray(range[0], range[1]));
}

describe("blockByteRanges", () => {
  it("splits plain top-level paragraphs on a blank line", () => {
    const source = "First paragraph.\n\nSecond paragraph.";
    const ranges = blockByteRanges(source);
    expect(ranges.map((r) => textOf(source, r))).toEqual(["First paragraph.", "Second paragraph."]);
  });

  it("collapses a run of 3+ blank lines into a single split", () => {
    const source = "First.\n\n\n\nSecond.";
    const ranges = blockByteRanges(source);
    expect(ranges.map((r) => textOf(source, r))).toEqual(["First.", "Second."]);
  });

  it("returns a single block for text with no blank line", () => {
    const source = "Just one paragraph, no split here.";
    expect(blockByteRanges(source)).toEqual([[0, utf16ToByteOffset(source, source.length)]]);
  });

  // Fact-checked live against the real compiler (phase4-product-validation.md,
  // 2026-09-10): a blank line inside a list item ends the list — the content
  // after it becomes a new top-level paragraph. No brackets are involved in
  // Typst's own list-item syntax, so this should split exactly like plain
  // paragraphs do.
  it("splits a list item's blank-line continuation, matching Typst's own rule", () => {
    const source = "- First item\n\ncontinued as a new top-level paragraph\n- Second item";
    const ranges = blockByteRanges(source);
    expect(ranges.map((r) => textOf(source, r))).toEqual([
      "- First item",
      "continued as a new top-level paragraph\n- Second item",
    ]);
  });

  // The bug this module exists to fix: a blank line inside a table cell
  // (nested inside `#table(...)`'s `(...)` and the cell's own `[...]`) does
  // *not* end anything in real Typst, but a plain `\n{2,}` regex doesn't know
  // that and splits there anyway — confirmed live as clicking into such a
  // cell showing unrelated text from elsewhere in the document.
  it("does not split a blank line nested inside a table cell's brackets", () => {
    const source = "#table(\n  columns: 2,\n  [cell one\n\n  still cell one], [cell two],\n)";
    const ranges = blockByteRanges(source);
    expect(ranges).toHaveLength(1);
    expect(textOf(source, ranges[0])).toBe(source);
  });

  it("still splits on a real top-level blank line that follows a table call", () => {
    const source = "#table(\n  [cell one],\n)\n\nA paragraph after the table.";
    const ranges = blockByteRanges(source);
    expect(ranges.map((r) => textOf(source, r))).toEqual([
      "#table(\n  [cell one],\n)",
      "A paragraph after the table.",
    ]);
  });

  it("does not split inside a nested figure/content-block argument either", () => {
    const source = "#figure[\n  Some caption text\n\n  that continues here\n]";
    const ranges = blockByteRanges(source);
    expect(ranges).toHaveLength(1);
  });

  it("ignores bracket-like characters inside a string literal", () => {
    // Without string-skipping, the unmatched "(" here would push depth to 1
    // forever, and the blank line below would wrongly fail to split.
    const source = '#let s = "(unbalanced"\n\nNext paragraph.';
    const ranges = blockByteRanges(source);
    expect(ranges.map((r) => textOf(source, r))).toEqual(['#let s = "(unbalanced"', "Next paragraph."]);
  });

  it("ignores bracket-like characters inside a line comment", () => {
    const source = "// see [ref] and (note)\n\nNext paragraph.";
    const ranges = blockByteRanges(source);
    expect(ranges.map((r) => textOf(source, r))).toEqual(["// see [ref] and (note)", "Next paragraph."]);
  });

  it("ignores bracket-like characters inside a raw span", () => {
    const source = "Some text with `foo(bar]` inline code.\n\nNext paragraph.";
    const ranges = blockByteRanges(source);
    expect(ranges.map((r) => textOf(source, r))).toEqual([
      "Some text with `foo(bar]` inline code.",
      "Next paragraph.",
    ]);
  });

  it("handles CJK content with correct byte offsets", () => {
    const source = "第一段落，包含中文字符。\n\n第二段落。";
    const ranges = blockByteRanges(source);
    expect(ranges.map((r) => textOf(source, r))).toEqual(["第一段落，包含中文字符。", "第二段落。"]);
  });
});

describe("blockAt", () => {
  it("finds the block containing a given byte offset", () => {
    const source = "AAAA\n\nBBBB";
    const ranges = blockByteRanges(source);
    expect(blockAt(ranges, 0)).toBe(0);
    expect(blockAt(ranges, 2)).toBe(0);
    const bByte = utf16ToByteOffset(source, source.indexOf("BBBB"));
    expect(blockAt(ranges, bByte)).toBe(1);
  });

  it("returns null for an offset past the end", () => {
    const source = "AAAA";
    const ranges = blockByteRanges(source);
    expect(blockAt(ranges, 999)).toBeNull();
  });
});
