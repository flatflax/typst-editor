import { describe, expect, it } from "vitest";
import type { RawRangeBox } from "./typstCursor";
import {
  computeSplitLayoutFromBoxes,
  cropSvgVertically,
  estimatePlaceholderHeightPt,
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

describe("estimatePlaceholderHeightPt", () => {
  it("scales linearly with byte length once a real ink-to-byte ratio is known", () => {
    // One known block: 100 bytes -> 20pt tall, i.e. 0.2pt/byte.
    const known = [{ byteLength: 100, heightPt: 20 }];
    expect(estimatePlaceholderHeightPt(50, known)).toBeCloseTo(10);
    expect(estimatePlaceholderHeightPt(200, known)).toBeCloseTo(40);
  });

  it("averages the ratio across every known block, not just the first", () => {
    const known = [
      { byteLength: 100, heightPt: 20 }, // 0.2 pt/byte
      { byteLength: 100, heightPt: 40 }, // 0.4 pt/byte
    ];
    // Combined: 200 bytes -> 60pt, i.e. 0.3 pt/byte average.
    expect(estimatePlaceholderHeightPt(100, known)).toBeCloseTo(30);
  });

  it("falls back to a fixed rough guess when nothing is known yet, instead of collapsing to zero", () => {
    const estimate = estimatePlaceholderHeightPt(80, []);
    expect(estimate).toBeGreaterThan(0);
    // Matches the documented fallback constant (14pt line height / 80 bytes).
    expect(estimate).toBeCloseTo(14);
  });

  it("ignores blocks with zero byte length in the known set rather than producing NaN", () => {
    const known = [{ byteLength: 0, heightPt: 0 }];
    expect(Number.isFinite(estimatePlaceholderHeightPt(50, known))).toBe(true);
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

  const noEmptyBlocks: ReadonlySet<number> = new Set();

  it("returns null when the block's own ink isn't known yet", () => {
    const inkRanges = new Map([[1, { yTopPt: 200, heightPt: 40 }]]);
    expect(fairShareBoundsFromInk(0, inkRanges, noEmptyBlocks, 3, pageHeightPt)).toBeNull();
  });

  it("returns null when a neighbor that genuinely exists hasn't been fetched yet", () => {
    // block 1 of 3 needs both neighbors (0 and 2) - only 0 is known.
    const inkRanges = new Map([
      [0, { yTopPt: 100, heightPt: 40 }],
      [1, { yTopPt: 200, heightPt: 40 }],
    ]);
    expect(fairShareBoundsFromInk(1, inkRanges, noEmptyBlocks, 3, pageHeightPt)).toBeNull();
  });

  it("does not wait for a neighbor that doesn't exist (first/last block)", () => {
    const inkRanges = new Map([
      [0, { yTopPt: 100, heightPt: 40 }],
      [1, { yTopPt: 200, heightPt: 40 }],
    ]);
    // block 0 is first (no prev needed) but still needs block 1 (its only neighbor).
    const first = fairShareBoundsFromInk(0, inkRanges, noEmptyBlocks, 2, pageHeightPt);
    expect(first).not.toBeNull();
    expect(first!.yTopPt).toBe(0);
    // block 1 is last (no next needed) and has its only neighbor (block 0).
    const last = fairShareBoundsFromInk(1, inkRanges, noEmptyBlocks, 2, pageHeightPt);
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
      expect(fairShareBoundsFromInk(i, inkRanges, noEmptyBlocks, dense.length, pageHeightPt)).toEqual(
        fairShareBoundsForIndex(i, dense, pageHeightPt),
      );
    }
  });

  // Regression guard for a bug found live (2026-09-14): a block that renders
  // literally nothing (e.g. a `#set text(...)` line — a real block boundary,
  // but zero glyphs, so its own ink can never arrive) used to be
  // indistinguishable from "not fetched yet", which meant it could never
  // resolve out of its own placeholder *and* permanently blocked its
  // neighbor's fair share too, since the neighbor's own midpoint math needs
  // to know where this block sits.
  describe("with a confirmed-empty block (e.g. a #set line)", () => {
    it("gives the empty block itself a zero-height share at the midpoint of its real neighbors", () => {
      // Document: [real block 0] [empty block 1] [real block 2].
      const inkRanges = new Map([
        [0, { yTopPt: 100, heightPt: 40 }],
        [2, { yTopPt: 300, heightPt: 40 }],
      ]);
      const emptyBlocks = new Set([1]);
      const result = fairShareBoundsFromInk(1, inkRanges, emptyBlocks, 3, pageHeightPt);
      expect(result).not.toBeNull();
      expect(result!.heightPt).toBe(0);
      // Midpoint between block 0's bottom edge (140) and block 2's top edge (300).
      expect(result!.yTopPt).toBe((140 + 300) / 2);
    });

    it("does not block its neighbor from resolving — the empty block is skipped, not waited on", () => {
      // Document: [empty block 0] [real block 1] [real block 2]. Block 1's
      // own fair share needs a "previous neighbor" position, but block 0
      // will never have real ink — it must resolve by walking past block 0
      // to the page edge instead of returning null forever.
      const inkRanges = new Map([
        [1, { yTopPt: 200, heightPt: 40 }],
        [2, { yTopPt: 300, heightPt: 40 }],
      ]);
      const emptyBlocks = new Set([0]);
      const result = fairShareBoundsFromInk(1, inkRanges, emptyBlocks, 3, pageHeightPt);
      expect(result).not.toBeNull();
      expect(result!.yTopPt).toBe(0); // no real block before it -> page top, not stuck waiting on block 0
    });

    it("skips past multiple consecutive empty blocks to find real ink on either side", () => {
      // [real 0] [empty 1] [empty 2] [real 3].
      const inkRanges = new Map([
        [0, { yTopPt: 100, heightPt: 40 }],
        [3, { yTopPt: 400, heightPt: 40 }],
      ]);
      const emptyBlocks = new Set([1, 2]);
      const resultForBlock1 = fairShareBoundsFromInk(1, inkRanges, emptyBlocks, 4, pageHeightPt);
      expect(resultForBlock1).not.toBeNull();
      expect(resultForBlock1!.heightPt).toBe(0);
      const resultForBlock0 = fairShareBoundsFromInk(0, inkRanges, emptyBlocks, 4, pageHeightPt);
      // block 0's next real neighbor is block 3, skipping over 1 and 2.
      expect(resultForBlock0).not.toBeNull();
      expect(resultForBlock0!.yTopPt + resultForBlock0!.heightPt).toBe((140 + 400) / 2);
    });

    it("still waits (returns null) for a genuinely not-yet-fetched neighbor, not confusing it with an empty one", () => {
      // Document: [real 0] [unknown 1, neither ink nor confirmed empty] [real 2].
      const inkRanges = new Map([
        [0, { yTopPt: 100, heightPt: 40 }],
        [2, { yTopPt: 300, heightPt: 40 }],
      ]);
      const emptyBlocks: ReadonlySet<number> = new Set(); // block 1 is neither known nor empty
      expect(fairShareBoundsFromInk(0, inkRanges, emptyBlocks, 3, pageHeightPt)).toBeNull();
    });
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
