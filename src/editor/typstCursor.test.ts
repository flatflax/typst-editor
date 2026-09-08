import { describe, expect, it } from "vitest";
import {
  caretRectFromBoxes,
  selectionRectsFromBoxes,
  stepByteOffset,
  verticalMoveTargetY,
  type RawRangeBox,
} from "./typstCursor";

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
    expect(rect).toEqual({ xPt: 50, yTopPt: 20, heightPt: 12 });
  });

  it("falls back to the trailing edge of the character before the cursor at end of document", () => {
    const pageOffsetsPt = [0];
    const before = [box({ x_pt: 50, y_top_pt: 20, width_pt: 8 })];
    const rect = caretRectFromBoxes(pageOffsetsPt, before, []);
    expect(rect).toEqual({ xPt: 58, yTopPt: 20, heightPt: 12 });
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
    expect(rect).toEqual({ xPt: 28, yTopPt: 20, heightPt: 12 });
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

describe("verticalMoveTargetY", () => {
  it("moves up by approximately one line height from the caret's vertical center", () => {
    const caret = { xPt: 0, yTopPt: 100, heightPt: 12 };
    expect(verticalMoveTargetY(caret, "up")).toBe(100 + 6 - 12);
  });

  it("moves down by approximately one line height from the caret's vertical center", () => {
    const caret = { xPt: 0, yTopPt: 100, heightPt: 12 };
    expect(verticalMoveTargetY(caret, "down")).toBe(100 + 6 + 12);
  });
});
