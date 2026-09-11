// Pure split-mode layout math for the "focus-reveals-source" mechanism
// (interaction-design.md §6), extracted from the Phase 4 spikes
// (FocusRevealSpike2/3.tsx) once real-machine testing confirmed the
// mechanism (phase4-product-validation.md, 2026-09-10) — mirrors how
// `blockSplit.ts` was already pulled out of the same spikes. Isolated here,
// independent of any one component's state/effects, specifically because
// this is exactly the code that had a real, subtle bug this session (the
// focus-entry stutter: computing this *after* flipping to split mode,
// instead of before, showed one wrong frame before correcting itself) —
// worth unit-testing in isolation rather than only exercising it through a
// live component.
//
// Split mode shows N-1 unfocused sibling blocks as real DOM elements
// (cropped bands of the same combined SVG) plus one focused block as a
// native `<textarea>`, so the focused block's growth pushes siblings in
// normal document flow (an absolutely-positioned overlay was considered and
// rejected — phase4-product-validation.md's "third pass" — since a growing
// overlay would cover the next paragraph instead). Every block gets its
// "fair share" of the page's vertical space (not just its own ink's
// bounds), or spacing/margins collapse and paragraphs read as crammed
// together (phase4-product-validation.md's "fourth/fifth/sixth pass").

import type { AbsoluteRect, RawRangeBox } from "./typstCursor";
import { selectionRectsFromBoxes } from "./typstCursor";

export type BlockYRange = { yTopPt: number; heightPt: number };

export type FocusedLayoutPx = {
  width: number;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
};

export function parseViewBox(svg: string | null): string | null {
  if (!svg) return null;
  // Cheaper than mounting into the DOM just to read one attribute back —
  // `svg_merged`'s own output always has a plain `viewBox="..."` attribute
  // on its root element (see typst-svg's `svg_header`).
  const match = svg.match(/<svg[^>]*\sviewBox="([^"]+)"/);
  return match ? match[1] : null;
}

export function pageDimsFromSvg(svg: string | null): { widthPt: number; heightPt: number } | null {
  const viewBox = parseViewBox(svg);
  if (!viewBox) return null;
  const parts = viewBox.trim().split(/\s+/).map(Number);
  return parts.length === 4 ? { widthPt: parts[2], heightPt: parts[3] } : null;
}

export function unionYRange(rects: AbsoluteRect[]): BlockYRange | null {
  if (rects.length === 0) return null;
  const yTopPt = Math.min(...rects.map((r) => r.yTopPt));
  const yBottomPt = Math.max(...rects.map((r) => r.yTopPt + r.heightPt));
  return { yTopPt, heightPt: yBottomPt - yTopPt };
}

// Block `idx`'s "fair share" of the page's vertical space extends up to the
// true page top (if it's first) or the midpoint with its previous neighbor,
// and down to the true page bottom (if it's last) or the midpoint with its
// next neighbor — needs every block's own ink range (not just its
// neighbors') since the array itself is what identifies who those
// neighbors are.
export function fairShareBoundsForIndex(
  idx: number,
  ownRanges: BlockYRange[],
  pageHeightPt: number,
): BlockYRange {
  const prev = ownRanges[idx - 1];
  const next = ownRanges[idx + 1];
  const top = prev ? (prev.yTopPt + prev.heightPt + ownRanges[idx].yTopPt) / 2 : 0;
  const bottom = next ? (ownRanges[idx].yTopPt + ownRanges[idx].heightPt + next.yTopPt) / 2 : pageHeightPt;
  return { yTopPt: top, heightPt: bottom - top };
}

// Sparse version of `fairShareBoundsForIndex`: computes block `idx`'s fair
// share using only whatever neighbor ink is *known so far* (`inkRanges`),
// instead of requiring the whole document's geometry fetched up front.
// Needed once a real multi-page document made "fetch every block's geometry
// in one `block_geometry` call" too slow to gate every focus-entry/switch on
// — `geometry_for_range` (src-tauri) walks the *entire* document's glyphs
// per requested range, so one call covering every block costs
// O(block count × total glyphs); fetching only a block and its immediate
// neighbors, lazily, keeps each individual call's cost bounded regardless of
// document size (phase4-product-validation.md).
//
// Returns `null` — "not ready, don't guess" — if a neighbor that genuinely
// exists (per `totalBlocks`) hasn't been fetched yet. That's a different
// case from "this is the first/last block" (`hasPrev`/`hasNext` false),
// which correctly extends to the page edge instead of waiting for a
// neighbor that was never going to arrive.
export function fairShareBoundsFromInk(
  idx: number,
  inkRanges: Map<number, BlockYRange>,
  totalBlocks: number,
  pageHeightPt: number,
): BlockYRange | null {
  const own = inkRanges.get(idx);
  if (!own) return null;
  const hasPrev = idx > 0;
  const hasNext = idx < totalBlocks - 1;
  const prev = hasPrev ? inkRanges.get(idx - 1) : undefined;
  const next = hasNext ? inkRanges.get(idx + 1) : undefined;
  if ((hasPrev && !prev) || (hasNext && !next)) return null;
  const top = prev ? (prev.yTopPt + prev.heightPt + own.yTopPt) / 2 : 0;
  const bottom = next ? (own.yTopPt + own.heightPt + next.yTopPt) / 2 : pageHeightPt;
  return { yTopPt: top, heightPt: bottom - top };
}

export function cropSvgVertically(svg: string, yTopPt: number, heightPt: number): string | null {
  const viewBoxMatch = svg.match(/viewBox="([^"]+)"/);
  if (!viewBoxMatch) return null;
  const [minX, , width] = viewBoxMatch[1].trim().split(/\s+/).map(Number);
  let result = svg.replace(/viewBox="[^"]+"/, `viewBox="${minX} ${yTopPt} ${width} ${heightPt}"`);
  result = result.replace(/(<svg[^>]*\sheight=")[^"]+(")/, `$1${heightPt}pt$2`);
  return result;
}

export type ContentBoundsPt = { leftPt: number; rightPt: number };

// Widens (never narrows) a running "how far left/right has any block's ink
// reached" tracker as more blocks' geometry arrives — the lazy-fetch
// equivalent of `computeSplitLayoutFromBoxes`'s one-shot "pool every block's
// boxes" (a single short paragraph might never reach the page's true
// left/right content edge on its own, phase4-product-validation.md's
// "sixth pass"). Starting `current` as `null` and widening it incrementally
// converges to the same answer as the whole-document version would have,
// just arriving over time instead of all at once.
export function widenContentBounds(current: ContentBoundsPt | null, boxes: RawRangeBox[]): ContentBoundsPt | null {
  if (boxes.length === 0) return current;
  const leftPt = Math.min(...boxes.map((b) => b.x_pt), current?.leftPt ?? Infinity);
  const rightPt = Math.max(...boxes.map((b) => b.x_pt + b.width_pt), current?.rightPt ?? -Infinity);
  return { leftPt, rightPt };
}

// The focused block's own textarea width/margins, given its fair-share
// bounds and own ink range (both already resolved — see
// `fairShareBoundsFromInk`) plus however much of the document's horizontal
// content extent is known so far (`widenContentBounds`). Same formula as
// `computeSplitLayoutFromBoxes`'s focused-block half, just fed from
// incrementally-gathered inputs instead of one whole-document snapshot.
export function focusedLayoutPxFromInk(
  focusedFairShare: BlockYRange,
  focusedOwnInk: BlockYRange,
  contentBoundsPt: ContentBoundsPt,
  pageDims: { widthPt: number; heightPt: number },
  lockedWidthPx: number | null,
): FocusedLayoutPx {
  const scale = (lockedWidthPx ?? pageDims.widthPt) / pageDims.widthPt;
  return {
    width: Math.max(0, (contentBoundsPt.rightPt - contentBoundsPt.leftPt) * scale),
    marginLeft: Math.max(0, contentBoundsPt.leftPt * scale),
    marginRight: Math.max(0, (pageDims.widthPt - contentBoundsPt.rightPt) * scale),
    marginTop: Math.max(0, (focusedOwnInk.yTopPt - focusedFairShare.yTopPt) * scale),
    marginBottom: Math.max(
      0,
      (focusedFairShare.yTopPt + focusedFairShare.heightPt - (focusedOwnInk.yTopPt + focusedOwnInk.heightPt)) * scale,
    ),
  };
}

// The core split-mode layout computation, given `block_geometry`'s
// already-fetched results for every block's own byte range (one entry per
// block, in block order) — kept separate from the `invoke` call itself so
// this can be unit-tested without a Tauri/mock harness, matching
// `blockSplit.ts`'s own approach. Returns `null` if the geometry doesn't
// (yet) agree with `idx`/the block count — e.g. mid-transition, before a
// commit's resulting recompile has landed — callers should treat that the
// same as "not ready yet", not as an error.
export function computeSplitLayoutFromBoxes(
  boxesPerBlock: RawRangeBox[][],
  pageOffsetsPt: number[],
  idx: number,
  pageDims: { widthPt: number; heightPt: number },
  lockedWidthPx: number | null,
): { otherMap: Map<number, BlockYRange>; focusedLayoutPx: FocusedLayoutPx } | null {
  const ownRanges = boxesPerBlock.map((boxes) => unionYRange(selectionRectsFromBoxes(pageOffsetsPt, boxes)));
  if (ownRanges.some((r) => r == null) || idx < 0 || idx >= ownRanges.length) return null;
  const validRanges = ownRanges as BlockYRange[];

  const otherMap = new Map<number, BlockYRange>();
  for (let i = 0; i < validRanges.length; i++) {
    if (i === idx) continue;
    otherMap.set(i, fairShareBoundsForIndex(i, validRanges, pageDims.heightPt));
  }

  const focusedRange = validRanges[idx];
  const focusedFairShare = fairShareBoundsForIndex(idx, validRanges, pageDims.heightPt);
  const scale = (lockedWidthPx ?? pageDims.widthPt) / pageDims.widthPt;
  const allBoxes = boxesPerBlock.flat();
  const contentLeftPt = allBoxes.length ? Math.min(...allBoxes.map((b) => b.x_pt)) : 0;
  const contentRightPt = allBoxes.length ? Math.max(...allBoxes.map((b) => b.x_pt + b.width_pt)) : pageDims.widthPt;
  return {
    otherMap,
    focusedLayoutPx: {
      width: Math.max(0, (contentRightPt - contentLeftPt) * scale),
      marginLeft: Math.max(0, contentLeftPt * scale),
      marginRight: Math.max(0, (pageDims.widthPt - contentRightPt) * scale),
      marginTop: Math.max(0, (focusedRange.yTopPt - focusedFairShare.yTopPt) * scale),
      marginBottom: Math.max(
        0,
        (focusedFairShare.yTopPt + focusedFairShare.heightPt - (focusedRange.yTopPt + focusedRange.heightPt)) * scale,
      ),
    },
  };
}
