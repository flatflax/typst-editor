// M20 (plan.md): pure geometry/offset math for a self-drawn cursor/selection
// over live Typst rendering. Deliberately holds no DOM/React/Tauri logic —
// takes whatever `block_geometry` (compile.rs, M14A/M15a) already returns and
// converts it into absolute positions on the single rendered multi-page SVG
// (`compile_typst`'s `page_offsets_pt`, M20), or computes where a
// synthesized click should land for arrow-key vertical movement.

import { byteToUtf16Offset, nextCodePointOffset, prevCodePointOffset, utf16ToByteOffset } from "../util/offsets";

// The Typst byte offset one code point left/right of `byteOffset` — used
// both for arrow-key navigation and for constructing the before/after
// geometry query ranges the caret is positioned from. Round-trips through
// UTF-16 (`util/offsets.ts`) since `nextCodePointOffset`/`prevCodePointOffset`
// operate on JS string indices, not Typst's UTF-8 byte offsets. A no-op at
// the start/end of `source` (mirrors `nextCodePointOffset`/
// `prevCodePointOffset`'s own clamping).
export function stepByteOffset(source: string, byteOffset: number, direction: "left" | "right"): number {
  const utf16Offset = byteToUtf16Offset(source, byteOffset);
  const steppedUtf16 =
    direction === "left" ? prevCodePointOffset(source, utf16Offset) : nextCodePointOffset(source, utf16Offset);
  return utf16ToByteOffset(source, steppedUtf16);
}

// The raw shape `block_geometry` returns per range — one entry per M14A
// `RangeBox` line/shape box, snake_case straight off the wire.
export type RawRangeBox = {
  page: number;
  x_pt: number;
  y_top_pt: number;
  width_pt: number;
  height_pt: number;
  baseline_from_top_pt: number | null;
};

// A box's position in `svg_merged`'s single merged coordinate space —
// what M20's overlay actually renders, as opposed to `RawRangeBox`'s
// page-relative `y_top_pt`.
export type AbsoluteRect = {
  xPt: number;
  yTopPt: number;
  widthPt: number;
  heightPt: number;
};

export type CaretRect = {
  xPt: number;
  yTopPt: number;
  heightPt: number;
};

function toAbsolute(pageOffsetsPt: number[], box: RawRangeBox): AbsoluteRect {
  const pageOffset = pageOffsetsPt[box.page - 1] ?? 0;
  return { xPt: box.x_pt, yTopPt: pageOffset + box.y_top_pt, widthPt: box.width_pt, heightPt: box.height_pt };
}

// One rect per box, for rendering a selection highlight — `block_geometry`
// already returns one box per visual line/shape (M14A), including correctly
// across a page break, so this needs no clustering of its own.
export function selectionRectsFromBoxes(pageOffsetsPt: number[], boxes: RawRangeBox[]): AbsoluteRect[] {
  return boxes.map((box) => toAbsolute(pageOffsetsPt, box));
}

// Caret placement: prefer the LEADING edge of the character immediately
// after the cursor (`afterBoxes`) — natural for the common case of
// navigating/typing forward, and the only option at the very start of the
// document (no `beforeBoxes` at offset 0). Falls back to the TRAILING edge
// of the character immediately before the cursor (`beforeBoxes`) when
// there's nothing after (end of document) or the "after" query came back
// empty. Doesn't attempt to resolve line-wrap-boundary affinity (the
// "start of line 2" vs. "end of line 1" ambiguity at a soft wrap) — a known
// heuristic limit inherited from M14A's line-box clustering, not solved
// here; the leading-edge default just picks one side consistently.
export function caretRectFromBoxes(
  pageOffsetsPt: number[],
  beforeBoxes: RawRangeBox[],
  afterBoxes: RawRangeBox[],
): CaretRect | null {
  if (afterBoxes.length > 0) {
    const abs = toAbsolute(pageOffsetsPt, afterBoxes[0]);
    return { xPt: abs.xPt, yTopPt: abs.yTopPt, heightPt: abs.heightPt };
  }
  if (beforeBoxes.length > 0) {
    const abs = toAbsolute(pageOffsetsPt, beforeBoxes[beforeBoxes.length - 1]);
    return { xPt: abs.xPt + abs.widthPt, yTopPt: abs.yTopPt, heightPt: abs.heightPt };
  }
  return null;
}

// Where a synthesized click should land (in the merged coordinate space) to
// move the caret up/down by approximately one line — `caret.heightPt` is
// used as the line-height estimate (a real box's own height, not a document-
// wide constant), so it degrades gracefully across differently-sized text
// but isn't exact for varying line heights within a paragraph. `jump_from_click`
// (jump.rs, fixed for M20) resolves whichever page this Y actually falls on
// and clamps to the document's start/end, so overshooting slightly at the
// first/last line is fine.
export function verticalMoveTargetY(caret: CaretRect, direction: "up" | "down"): number {
  const midY = caret.yTopPt + caret.heightPt / 2;
  return direction === "up" ? midY - caret.heightPt : midY + caret.heightPt;
}
