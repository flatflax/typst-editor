import { describe, expect, it } from "vitest";
import type { RawRangeBox } from "./typstCursor";
import {
  computeSplitLayoutFromBoxes,
  cropSvgVertically,
  fairShareBoundsForIndex,
  fairShareBoundsFromInk,
  focusedLayoutPxFromInk,
  pageDimsFromSvg,
  parseViewBox,
  unionYRange,
  widenContentBounds,
} from "./splitLayout";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800" width="600pt" height="800pt"><g/></svg>';

function box(x: number, yTop: number, width: number, height: number): RawRangeBox {
  return { page: 1, x_pt: x, y_top_pt: yTop, width_pt: width, height_pt: height, baseline_from_top_pt: null };
}

describe("parseViewBox / pageDimsFromSvg", () => {
  it("extracts the viewBox and page dimensions", () => {
    expect(parseViewBox(SVG)).toBe("0 0 600 800");
    expect(pageDimsFromSvg(SVG)).toEqual({ widthPt: 600, heightPt: 800 });
  });

  it("returns null for missing/malformed input", () => {
    expect(parseViewBox(null)).toBeNull();
    expect(pageDimsFromSvg(null)).toBeNull();
    expect(pageDimsFromSvg("<svg></svg>")).toBeNull();
  });
});

describe("unionYRange", () => {
  it("returns null for an empty rect list", () => {
    expect(unionYRange([])).toBeNull();
  });

  it("spans from the topmost to the bottommost edge across multiple rects", () => {
    const result = unionYRange([
      { xPt: 0, yTopPt: 50, widthPt: 10, heightPt: 20 },
      { xPt: 0, yTopPt: 10, widthPt: 10, heightPt: 15 },
    ]);
    // topmost edge: 10; bottommost edge: 50 + 20 = 70
    expect(result).toEqual({ yTopPt: 10, heightPt: 60 });
  });
});

describe("fairShareBoundsForIndex", () => {
  // Mirrors phase4-product-validation.md's "fourth pass": a tight crop to a
  // block's own ink discarded page margins and inter-paragraph gaps. Every
  // block should get its fair share of the page instead.
  const pageHeightPt = 800;
  const ranges = [
    { yTopPt: 100, heightPt: 40 }, // block 0
    { yTopPt: 200, heightPt: 40 }, // block 1
    { yTopPt: 300, heightPt: 40 }, // block 2
  ];

  it("extends the first block up to the true page top", () => {
    expect(fairShareBoundsForIndex(0, ranges, pageHeightPt).yTopPt).toBe(0);
  });

  it("extends the last block down to the true page bottom", () => {
    const last = fairShareBoundsForIndex(2, ranges, pageHeightPt);
    expect(last.yTopPt + last.heightPt).toBe(pageHeightPt);
  });

  it("splits the gap between two blocks at the midpoint", () => {
    const first = fairShareBoundsForIndex(0, ranges, pageHeightPt);
    const middle = fairShareBoundsForIndex(1, ranges, pageHeightPt);
    // gap between block 0 (ends at 140) and block 1 (starts at 200): midpoint 170
    expect(first.yTopPt + first.heightPt).toBe(170);
    expect(middle.yTopPt).toBe(170);
  });
});

describe("cropSvgVertically", () => {
  it("rewrites viewBox y/height and the height attribute, leaving width untouched", () => {
    const cropped = cropSvgVertically(SVG, 120, 45);
    expect(cropped).toContain('viewBox="0 120 600 45"');
    expect(cropped).toContain('height="45pt"');
    expect(cropped).toContain('width="600pt"');
  });

  it("returns null when there's no viewBox to rewrite", () => {
    expect(cropSvgVertically("<svg></svg>", 0, 10)).toBeNull();
  });
});

describe("computeSplitLayoutFromBoxes", () => {
  const pageDims = { widthPt: 600, heightPt: 800 };
  const pageOffsetsPt = [0];

  it("returns null when a block has no geometry (e.g. mid-transition)", () => {
    const boxesPerBlock = [[box(50, 100, 200, 20)], []];
    expect(computeSplitLayoutFromBoxes(boxesPerBlock, pageOffsetsPt, 0, pageDims, null)).toBeNull();
  });

  it("returns null when idx is out of range", () => {
    const boxesPerBlock = [[box(50, 100, 200, 20)]];
    expect(computeSplitLayoutFromBoxes(boxesPerBlock, pageOffsetsPt, 5, pageDims, null)).toBeNull();
  });

  it("computes fair-share crops for every block except the focused one", () => {
    const boxesPerBlock = [[box(50, 100, 200, 20)], [box(50, 300, 200, 20)]];
    const result = computeSplitLayoutFromBoxes(boxesPerBlock, pageOffsetsPt, 0, pageDims, null);
    expect(result).not.toBeNull();
    expect(result!.otherMap.has(0)).toBe(false);
    expect(result!.otherMap.has(1)).toBe(true);
    // block 1 is last, so its fair share extends to the true page bottom.
    const block1 = result!.otherMap.get(1)!;
    expect(block1.yTopPt + block1.heightPt).toBe(pageDims.heightPt);
  });

  // Mirrors phase4-product-validation.md's "fifth pass": the focused block's
  // own leading/trailing page margin must come through as textarea
  // margin-top/margin-bottom, computed against its own fair-share bounds
  // exactly like an unfocused sibling's crop would be.
  it("gives the focused (first) block a margin-top matching its real leading gap", () => {
    const boxesPerBlock = [[box(50, 100, 200, 20)], [box(50, 300, 200, 20)]];
    const result = computeSplitLayoutFromBoxes(boxesPerBlock, pageOffsetsPt, 0, pageDims, null);
    // scale is 1 (lockedWidthPx null -> falls back to pageDims.widthPt)
    // block 0's fair share top is 0 (first block), its own ink starts at 100
    expect(result!.focusedLayoutPx.marginTop).toBe(100);
  });

  // Mirrors phase4-product-validation.md's "sixth pass": horizontal content
  // margins pooled from *all* blocks' line boxes, not just the focused
  // one's (a single short paragraph might never reach the true content
  // edge on its own).
  it("pools every block's line boxes to compute horizontal content margins", () => {
    const boxesPerBlock = [
      [box(50, 100, 100, 20)], // focused block: narrower content
      [box(30, 300, 300, 20)], // sibling reaches further left and right
    ];
    const result = computeSplitLayoutFromBoxes(boxesPerBlock, pageOffsetsPt, 0, pageDims, null);
    // pooled content spans x=[30, 330] -> marginLeft 30, marginRight 600-330=270
    expect(result!.focusedLayoutPx.marginLeft).toBe(30);
    expect(result!.focusedLayoutPx.marginRight).toBe(270);
  });

  it("scales margins/width by lockedWidthPx ÷ page width when the textarea is locked to a rendered pixel width", () => {
    const boxesPerBlock = [[box(50, 100, 200, 20)]];
    // page is 600pt wide, locked to 300px on screen -> scale 0.5
    const result = computeSplitLayoutFromBoxes(boxesPerBlock, pageOffsetsPt, 0, pageDims, 300);
    expect(result!.focusedLayoutPx.width).toBe(100); // 200pt * 0.5
    expect(result!.focusedLayoutPx.marginLeft).toBe(25); // 50pt * 0.5
  });
});

// Lazily-fetched equivalents (phase4-product-validation.md, 2026-09-11):
// `geometry_for_range` (src-tauri) walks the *entire* document per requested
// range, so fetching every block's geometry in one `block_geometry` call —
// what `computeSplitLayoutFromBoxes` above assumes — costs O(block count ×
// total glyphs), confirmed live as very slow to enter/switch focus on a real
// multi-page document. These fetch/compute a block's fair-share from
// whatever neighbor ink is known *so far*, so a caller can fetch a small
// window (the focused block + immediate neighbors) instead of the whole
// document up front, backfilling the rest lazily.
describe("fairShareBoundsFromInk", () => {
  const pageHeightPt = 800;

  it("returns null when the block's own ink isn't known yet", () => {
    const inkRanges = new Map([[1, { yTopPt: 200, heightPt: 40 }]]);
    expect(fairShareBoundsFromInk(0, inkRanges, 3, pageHeightPt)).toBeNull();
  });

  it("returns null when a neighbor that genuinely exists hasn't been fetched yet", () => {
    // block 1 of 3 needs both neighbors (0 and 2) - only 0 is known.
    const inkRanges = new Map([
      [0, { yTopPt: 100, heightPt: 40 }],
      [1, { yTopPt: 200, heightPt: 40 }],
    ]);
    expect(fairShareBoundsFromInk(1, inkRanges, 3, pageHeightPt)).toBeNull();
  });

  it("does not wait for a neighbor that doesn't exist (first/last block)", () => {
    const inkRanges = new Map([
      [0, { yTopPt: 100, heightPt: 40 }],
      [1, { yTopPt: 200, heightPt: 40 }],
    ]);
    // block 0 is first (no prev needed) but still needs block 1 (its only neighbor).
    const first = fairShareBoundsFromInk(0, inkRanges, 2, pageHeightPt);
    expect(first).not.toBeNull();
    expect(first!.yTopPt).toBe(0);
    // block 1 is last (no next needed) and has its only neighbor (block 0).
    const last = fairShareBoundsFromInk(1, inkRanges, 2, pageHeightPt);
    expect(last).not.toBeNull();
    expect(last!.yTopPt + last!.heightPt).toBe(pageHeightPt);
  });

  it("matches the dense (whole-document) computation once every needed neighbor is known", () => {
    const dense = [
      { yTopPt: 100, heightPt: 40 },
      { yTopPt: 200, heightPt: 40 },
      { yTopPt: 300, heightPt: 40 },
    ];
    const inkRanges = new Map(dense.map((r, i) => [i, r] as const));
    for (let i = 0; i < dense.length; i++) {
      expect(fairShareBoundsFromInk(i, inkRanges, dense.length, pageHeightPt)).toEqual(
        fairShareBoundsForIndex(i, dense, pageHeightPt),
      );
    }
  });
});

describe("widenContentBounds", () => {
  it("starts from null and adopts the first batch's extent", () => {
    const result = widenContentBounds(null, [box(50, 0, 100, 10)]);
    expect(result).toEqual({ leftPt: 50, rightPt: 150 });
  });

  it("widens but never narrows as more (possibly narrower) boxes arrive", () => {
    const first = widenContentBounds(null, [box(50, 0, 100, 10)]); // [50, 150]
    const second = widenContentBounds(first, [box(80, 0, 20, 10)]); // [80, 100] - narrower, ignored
    expect(second).toEqual({ leftPt: 50, rightPt: 150 });
    const third = widenContentBounds(second, [box(10, 0, 400, 10)]); // [10, 410] - wider, adopted
    expect(third).toEqual({ leftPt: 10, rightPt: 410 });
  });

  it("leaves existing bounds untouched when given an empty batch", () => {
    const first = widenContentBounds(null, [box(50, 0, 100, 10)]);
    expect(widenContentBounds(first, [])).toEqual(first);
  });
});

describe("focusedLayoutPxFromInk", () => {
  const pageDims = { widthPt: 600, heightPt: 800 };

  it("matches computeSplitLayoutFromBoxes's focused-block math given the same effective inputs", () => {
    const boxesPerBlock = [[box(50, 100, 200, 20)], [box(30, 300, 300, 20)]];
    const dense = computeSplitLayoutFromBoxes(boxesPerBlock, [0], 0, pageDims, 300)!;

    const focusedFairShare = fairShareBoundsForIndex(0, [{ yTopPt: 100, heightPt: 20 }, { yTopPt: 300, heightPt: 20 }], pageDims.heightPt);
    const focusedOwnInk = { yTopPt: 100, heightPt: 20 };
    const contentBounds = widenContentBounds(widenContentBounds(null, boxesPerBlock[0]), boxesPerBlock[1])!;

    const sparse = focusedLayoutPxFromInk(focusedFairShare, focusedOwnInk, contentBounds, pageDims, 300);
    expect(sparse).toEqual(dense.focusedLayoutPx);
  });
});
