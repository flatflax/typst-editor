import { describe, expect, it } from "vitest";
import {
  caretRectFromBoxes,
  clampXToLine,
  currentParagraphText,
  lineContainingY,
  nearestAdjacentLine,
  selectionRectsFromBoxes,
  spliceSource,
  stepByteOffset,
  type RawRangeBox,
} from "./typstCursor";

function rect(overrides: Partial<{ xPt: number; yTopPt: number; widthPt: number; heightPt: number }> = {}) {
  return { xPt: 0, yTopPt: 0, widthPt: 100, heightPt: 12, ...overrides };
}

function box(overrides: Partial<RawRangeBox> = {}): RawRangeBox {
  return {
    page: 1,
    x_pt: 10,
    y_top_pt: 20,
    width_pt: 30,
    height_pt: 12,
    baseline_from_top_pt: 9,
    ...overrides,
  };
}

describe("selectionRectsFromBoxes", () => {
  it("converts a page-relative box to the merged coordinate space", () => {
    const pageOffsetsPt = [0, 300]; // page 2 starts at merged y 300
    const rects = selectionRectsFromBoxes(pageOffsetsPt, [box({ page: 2, y_top_pt: 20 })]);
    expect(rects).toEqual([{ xPt: 10, yTopPt: 320, widthPt: 30, heightPt: 12 }]);
  });

  it("returns one rect per box, preserving order (multi-line selection)", () => {
    const pageOffsetsPt = [0];
    const boxes = [box({ y_top_pt: 0 }), box({ y_top_pt: 20 }), box({ y_top_pt: 40 })];
    expect(selectionRectsFromBoxes(pageOffsetsPt, boxes)).toHaveLength(3);
  });

  it("treats a missing page offset as 0 rather than throwing", () => {
    const rects = selectionRectsFromBoxes([], [box({ page: 3, y_top_pt: 5 })]);
    expect(rects[0].yTopPt).toBe(5);
  });
});

describe("caretRectFromBoxes", () => {
  it("prefers the leading edge of the character after the cursor", () => {
    const pageOffsetsPt = [0];
    const after = [box({ x_pt: 50, y_top_pt: 20, width_pt: 8 })];
    const rect = caretRectFromBoxes(pageOffsetsPt, [], after);
    expect(rect).toEqual({ xPt: 50, yTopPt: 20, heightPt: 12, visualHeightPt: 9 });
  });

  it("falls back to the trailing edge of the character before the cursor at end of document", () => {
    const pageOffsetsPt = [0];
    const before = [box({ x_pt: 50, y_top_pt: 20, width_pt: 8 })];
    const rect = caretRectFromBoxes(pageOffsetsPt, before, []);
    expect(rect).toEqual({ xPt: 58, yTopPt: 20, heightPt: 12, visualHeightPt: 9 });
  });

  it("prefers the after-box even when a before-box is also available", () => {
    const pageOffsetsPt = [0];
    const before = [box({ x_pt: 10, width_pt: 8 })];
    const after = [box({ x_pt: 50, width_pt: 8 })];
    const rect = caretRectFromBoxes(pageOffsetsPt, before, after);
    expect(rect?.xPt).toBe(50);
  });

  it("uses the last before-box when there are several (multi-line before-range)", () => {
    const pageOffsetsPt = [0];
    const before = [box({ x_pt: 10, y_top_pt: 0 }), box({ x_pt: 20, y_top_pt: 20, width_pt: 8 })];
    const rect = caretRectFromBoxes(pageOffsetsPt, before, []);
    expect(rect).toEqual({ xPt: 28, yTopPt: 20, heightPt: 12, visualHeightPt: 9 });
  });

  it("resolves through the correct page offset for content on page 2+", () => {
    const pageOffsetsPt = [0, 500];
    const after = [box({ page: 2, x_pt: 15, y_top_pt: 30 })];
    const rect = caretRectFromBoxes(pageOffsetsPt, [], after);
    expect(rect?.yTopPt).toBe(530);
  });

  it("returns null when neither side has any geometry (e.g. an empty document)", () => {
    expect(caretRectFromBoxes([0], [], [])).toBeNull();
  });

  it("trims the visual height to the baseline, not the full ascent+descent box", () => {
    const pageOffsetsPt = [0];
    const after = [box({ height_pt: 12, baseline_from_top_pt: 9 })];
    const rect = caretRectFromBoxes(pageOffsetsPt, [], after);
    expect(rect?.heightPt).toBe(12); // full box, for vertical-move estimation
    expect(rect?.visualHeightPt).toBe(9); // trimmed, for drawing
  });

  it("falls back to the full height for a box with no baseline (an image)", () => {
    const pageOffsetsPt = [0];
    const after = [box({ height_pt: 40, baseline_from_top_pt: null })];
    const rect = caretRectFromBoxes(pageOffsetsPt, [], after);
    expect(rect?.visualHeightPt).toBe(40);
  });
});

describe("stepByteOffset", () => {
  it("steps by the correct byte width for a multi-byte CJK character", () => {
    const source = "a苹b"; // 苹 is 3 UTF-8 bytes
    expect(stepByteOffset(source, 1, "right")).toBe(4); // past 苹 (1 + 3)
    expect(stepByteOffset(source, 4, "left")).toBe(1); // back before 苹
  });

  it("is a no-op at the start/end of the source", () => {
    const source = "abc";
    expect(stepByteOffset(source, 0, "left")).toBe(0);
    expect(stepByteOffset(source, source.length, "right")).toBe(source.length);
  });

  it("round-trips right then left back to the same byte offset", () => {
    const source = "苹果 hello 世界";
    const byteLen = new TextEncoder().encode(source).length;
    let offset = 0;
    while (offset < byteLen) {
      const next = stepByteOffset(source, offset, "right");
      expect(stepByteOffset(source, next, "left")).toBe(offset);
      offset = next;
    }
  });
});

describe("nearestAdjacentLine", () => {
  // The three real failure modes found testing a document mixing a heading,
  // a wrapped paragraph, and a bullet list -- a single guessed multiplier of
  // "the current line's own height" couldn't handle all three at once
  // (see this function's own doc comment).
  it("does not skip past a paragraph's first wrapped line when moving down from a heading", () => {
    // A heading's own line is much taller than the body text below it.
    const headingLine = rect({ yTopPt: 0, heightPt: 30 });
    const paragraphLine1 = rect({ yTopPt: 40, heightPt: 12 });
    const paragraphLine2 = rect({ yTopPt: 55, heightPt: 12 });
    const lines = [headingLine, paragraphLine1, paragraphLine2];
    expect(nearestAdjacentLine(lines, headingLine.yTopPt, "down")).toEqual(paragraphLine1);
  });

  it("moves to the very next list item even when list-item spacing exceeds plain line height", () => {
    const item1 = rect({ yTopPt: 0, heightPt: 12 });
    const item2 = rect({ yTopPt: 25, heightPt: 12 }); // gap wider than heightPt alone
    const lines = [item1, item2];
    expect(nearestAdjacentLine(lines, item1.yTopPt, "down")).toEqual(item2);
  });

  it("does not skip a list's last item when moving up from the paragraph after it", () => {
    const item1 = rect({ yTopPt: 0, heightPt: 12 });
    const item2 = rect({ yTopPt: 20, heightPt: 12 });
    const paragraph = rect({ yTopPt: 45, heightPt: 12 });
    const lines = [item1, item2, paragraph];
    expect(nearestAdjacentLine(lines, paragraph.yTopPt, "up")).toEqual(item2);
  });

  it("ignores other boxes belonging to the same visual line (within the epsilon)", () => {
    const currentLine = rect({ yTopPt: 20, heightPt: 12 });
    const sameLineOtherHit = rect({ yTopPt: 20.2, heightPt: 12 }); // within SAME_LINE_EPSILON_PT
    const nextLine = rect({ yTopPt: 35, heightPt: 12 });
    const lines = [currentLine, sameLineOtherHit, nextLine];
    expect(nearestAdjacentLine(lines, currentLine.yTopPt, "down")).toEqual(nextLine);
  });

  it("returns null when there is nothing further in that direction (document start/end)", () => {
    const onlyLine = rect({ yTopPt: 20, heightPt: 12 });
    expect(nearestAdjacentLine([onlyLine], onlyLine.yTopPt, "up")).toBeNull();
    expect(nearestAdjacentLine([onlyLine], onlyLine.yTopPt, "down")).toBeNull();
  });
});

describe("clampXToLine", () => {
  // The real bug this fixes: moving onto a *shorter* line than the current
  // one aimed a synthesized click past where that line's content actually
  // ends, which jump_from_click couldn't resolve to anything -- the caret
  // appeared frozen instead of landing at the short line's end.
  it("clamps to the line's right edge when the sticky column is past it", () => {
    const shortLine = rect({ xPt: 10, widthPt: 20 }); // spans 10..30
    expect(clampXToLine(100, shortLine)).toBe(30);
  });

  it("clamps to the line's left edge when the sticky column is before it", () => {
    const line = rect({ xPt: 10, widthPt: 20 });
    expect(clampXToLine(0, line)).toBe(10);
  });

  it("leaves the column unchanged when it already falls within the line", () => {
    const line = rect({ xPt: 10, widthPt: 20 });
    expect(clampXToLine(15, line)).toBe(15);
  });
});

describe("lineContainingY", () => {
  // The real bug this fixes: clicking blank space (past a short line's
  // end, below the last line, in the margins, in the gap between lines)
  // gave jump_from_click nothing to resolve to, so the caret didn't move
  // at all -- unlike the vertical-navigation case, there's no "current
  // line" to clamp against here, since finding the right line *is* the
  // point of a click.
  it("prefers a line whose own vertical span actually contains the point", () => {
    const line1 = rect({ yTopPt: 0, heightPt: 12 });
    const line2 = rect({ yTopPt: 20, heightPt: 12 });
    expect(lineContainingY([line1, line2], 25)).toEqual(line2);
  });

  it("falls back to the nearest line when the point is above the first line", () => {
    const line1 = rect({ yTopPt: 20, heightPt: 12 });
    const line2 = rect({ yTopPt: 40, heightPt: 12 });
    expect(lineContainingY([line1, line2], 0)).toEqual(line1);
  });

  it("falls back to the nearest line when the point is below the last line", () => {
    const line1 = rect({ yTopPt: 0, heightPt: 12 });
    const line2 = rect({ yTopPt: 20, heightPt: 12 });
    expect(lineContainingY([line1, line2], 1000)).toEqual(line2);
  });

  it("falls back to the nearest line for a point landing in the gap between two lines", () => {
    const line1 = rect({ yTopPt: 0, heightPt: 12 }); // center at 6
    const line2 = rect({ yTopPt: 30, heightPt: 12 }); // center at 36
    expect(lineContainingY([line1, line2], 20)).toEqual(line1); // closer to line1's center
  });

  it("returns null for an empty document", () => {
    expect(lineContainingY([], 10)).toBeNull();
  });
});

describe("spliceSource", () => {
  it("inserts text at a collapsed cursor position (empty range)", () => {
    const result = spliceSource("ac", 1, 1, "b");
    expect(result).toEqual({ source: "abc", cursorOffset: 2 });
  });

  it("replaces a non-empty range with the given text", () => {
    const result = spliceSource("axxxc", 1, 4, "b");
    expect(result).toEqual({ source: "abc", cursorOffset: 2 });
  });

  it("deletes a range when insertText is empty", () => {
    const result = spliceSource("abc", 1, 2, "");
    expect(result).toEqual({ source: "ac", cursorOffset: 1 });
  });

  it("correctly splices around a multi-byte CJK character earlier in the source", () => {
    // "苹" is 3 UTF-8 bytes but 1 UTF-16 unit -- byte offsets after it must
    // not be treated as JS string indices directly.
    const source = "苹b"; // byte layout: 苹(0..3) b(3..4)
    const result = spliceSource(source, 4, 4, "c");
    expect(result).toEqual({ source: "苹bc", cursorOffset: 5 });
  });

  it("inserting a multi-byte character advances the cursor by its byte length, not char count", () => {
    const result = spliceSource("ab", 1, 1, "苹"); // 3 UTF-8 bytes
    expect(result).toEqual({ source: "a苹b", cursorOffset: 4 });
  });
});

describe("currentParagraphText", () => {
  it("returns the whole source when there is only one paragraph", () => {
    const source = "Hello world.";
    expect(currentParagraphText(source, 5)).toBe("Hello world.");
  });

  it("finds the paragraph between two blank-line boundaries", () => {
    const source = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    const offset = source.indexOf("Second") + 3;
    expect(currentParagraphText(source, offset)).toBe("Second paragraph.");
  });

  it("returns the first paragraph when the offset is in it", () => {
    const source = "First paragraph.\n\nSecond paragraph.";
    expect(currentParagraphText(source, 3)).toBe("First paragraph.");
  });

  it("returns the last paragraph when the offset is at the end of the document", () => {
    const source = "First paragraph.\n\nLast paragraph.";
    expect(currentParagraphText(source, source.length)).toBe("Last paragraph.");
  });

  it("handles a multi-byte CJK character before the offset correctly", () => {
    const source = "苹果段落。\n\n第二段。";
    const offset = new TextEncoder().encode("苹果段落。\n\n第").length; // partway into the second paragraph
    expect(currentParagraphText(source, offset)).toBe("第二段。");
  });
});
