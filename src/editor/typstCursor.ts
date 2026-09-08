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
  // The full box height (ascent + descent, per `geometry.rs`'s glyph-size
  // approximation) — used as the line-height estimate for vertical
  // navigation (`verticalMoveTargetY`), not for drawing the caret itself.
  heightPt: number;
  // Trimmed to end at the glyph's baseline instead of `heightPt`'s full
  // ascent+descent box — `geometry.rs`'s approximation deliberately
  // overshoots on both ends for generous hit-testing (real ascent is
  // usually well under the full font size it uses, and descent extends a
  // further 25% below the baseline for glyphs that don't actually have
  // one), which reads as "the caret hangs too low, into the next line's
  // space" once drawn as a visible bar rather than just used for click
  // matching. Falls back to `heightPt` for a box with no baseline (an
  // image) — there's no baseline concept to trim to.
  visualHeightPt: number;
};

function toAbsolute(pageOffsetsPt: number[], box: RawRangeBox): AbsoluteRect {
  const pageOffset = pageOffsetsPt[box.page - 1] ?? 0;
  return { xPt: box.x_pt, yTopPt: pageOffset + box.y_top_pt, widthPt: box.width_pt, heightPt: box.height_pt };
}

// One rect per box, for rendering a selection highlight — `block_geometry`
// already returns one box per visual line/shape (M14A), including correctly
// across a page break, so this needs no clustering of its own. Uses the full
// box (unlike the caret) since a selection highlight conventionally spans
// the whole line, not just ascent-to-baseline.
export function selectionRectsFromBoxes(pageOffsetsPt: number[], boxes: RawRangeBox[]): AbsoluteRect[] {
  return boxes.map((box) => toAbsolute(pageOffsetsPt, box));
}

function caretFromBox(pageOffsetsPt: number[], box: RawRangeBox, xPt: number): CaretRect {
  const abs = toAbsolute(pageOffsetsPt, box);
  return {
    xPt,
    yTopPt: abs.yTopPt,
    heightPt: abs.heightPt,
    visualHeightPt: box.baseline_from_top_pt ?? abs.heightPt,
  };
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
    const box = afterBoxes[0];
    return caretFromBox(pageOffsetsPt, box, toAbsolute(pageOffsetsPt, box).xPt);
  }
  if (beforeBoxes.length > 0) {
    const box = beforeBoxes[beforeBoxes.length - 1];
    const abs = toAbsolute(pageOffsetsPt, box);
    return caretFromBox(pageOffsetsPt, box, abs.xPt + abs.widthPt);
  }
  return null;
}

// Empirical: real Typst baseline-to-baseline line spacing (font size +
// default paragraph leading) measured about 1.38x the font size in a sample
// document (two consecutive text lines' SVG transforms 19.36pt apart at
// 14pt text — see the M18 IME harness's generated SVG). `caret.heightPt`
// (ascent+descent alone, ~1.25x font size) undershoots that by ~10% —
// small per press, but enough that a synthesized click sometimes landed
// back on the *same* line instead of clearing into the next one, which
// read as "Up/Down doesn't work." This multiplier adds a safety margin
// beyond just closing that gap exactly, since real leading varies by font/
// size and undershooting fails outright while overshooting merely risks
// skipping into the line beyond the immediate next one.
const LINE_STEP_MULTIPLIER = 1.4;

// Where a synthesized click should land (in the merged coordinate space) to
// move the caret up/down by approximately one line — `caret.heightPt` (the
// full ascent+descent box, not the trimmed `visualHeightPt`) is used as the
// line-height estimate, so it degrades gracefully across differently-sized
// text but isn't exact for varying line heights within a paragraph.
// `jump_from_click` (jump.rs, fixed for M20) resolves whichever page this Y
// actually falls on and clamps to the document's start/end, so overshooting
// slightly at the first/last line is fine.
export function verticalMoveTargetY(caret: CaretRect, direction: "up" | "down"): number {
  const midY = caret.yTopPt + caret.heightPt / 2;
  const step = caret.heightPt * LINE_STEP_MULTIPLIER;
  return direction === "up" ? midY - step : midY + step;
}
