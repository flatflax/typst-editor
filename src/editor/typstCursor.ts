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

// Line spacing genuinely differs across block types in the same document —
// a heading's line height, a paragraph's, and a list item's are all
// different, and Typst's own block spacing (space after a heading, spacing
// between list items) adds further variance on top of plain line leading.
// An earlier version of this function stepped by a multiplier of the
// *current* line's own height, which is exactly the assumption that breaks
// here: moving down from a heading skipped over the paragraph's first
// wrapped line entirely (the heading's line height overshot it), moving
// down from a list item's first line sometimes didn't move at all
// (undershot the gap to the next item), and moving up from body text past a
// list skipped its last item (same overshoot, opposite direction). No
// single multiplier holds across all three.
//
// This finds the real nearest line instead of guessing: given every line
// box in the (rendered) document, or a window around the caret, return
// whichever one sits strictly above/below `currentYPt` and is closest to
// it. `EPSILON_PT` absorbs floating-point noise and multiple boxes
// belonging to the *same* visual line (e.g. a line rendered as several
// glyph-run hits) without needing exact equality.
const SAME_LINE_EPSILON_PT = 0.5;

// `AbsoluteRect` (also used for selection highlights) rather than a
// yTopPt/heightPt-only shape — the caller needs the target line's own x/
// width too, to clamp the sticky-column X into it (see `clampXToLine`):
// without that, moving onto a *shorter* line than the current one aimed a
// synthesized click past where that line's content actually ends, which
// `jump_from_click` couldn't resolve to anything, so the caret appeared
// frozen.
export function nearestAdjacentLine(
  lines: AbsoluteRect[],
  currentYPt: number,
  direction: "up" | "down",
): AbsoluteRect | null {
  const candidates = lines.filter((line) =>
    direction === "down" ? line.yTopPt > currentYPt + SAME_LINE_EPSILON_PT : line.yTopPt < currentYPt - SAME_LINE_EPSILON_PT,
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((closest, line) => {
    const isCloser = direction === "down" ? line.yTopPt < closest.yTopPt : line.yTopPt > closest.yTopPt;
    return isCloser ? line : closest;
  });
}

// Sticky-column X, clamped into whatever the target line's own content
// actually spans — moving onto a shorter line should land at its end, not
// aim past it and fail to resolve to anything.
export function clampXToLine(xPt: number, line: AbsoluteRect): number {
  return Math.max(line.xPt, Math.min(line.xPt + line.widthPt, xPt));
}

// Same underlying problem as `nearestAdjacentLine`/`clampXToLine`, but for a
// *direct* click rather than a synthesized one: clicking blank space (past
// a short line's end, below the last line, in the margins, in the gap
// between lines) gives `jump_from_click` nothing to resolve to, so it
// returns null and the caret doesn't move at all — no line to clamp
// against, since finding the right line *is* the point of a click. Prefers
// a line whose own vertical span actually contains `yPt`; otherwise (a
// click above the first line, below the last, or landing exactly in an
// inter-line gap) falls back to whichever line's vertical center is
// nearest. Returns `null` only for an empty document.
export function lineContainingY(lines: AbsoluteRect[], yPt: number): AbsoluteRect | null {
  const containing = lines.find((line) => yPt >= line.yTopPt && yPt < line.yTopPt + line.heightPt);
  if (containing) return containing;
  if (lines.length === 0) return null;
  return lines.reduce((closest, line) => {
    const closestDist = Math.abs(yPt - (closest.yTopPt + closest.heightPt / 2));
    const lineDist = Math.abs(yPt - (line.yTopPt + line.heightPt / 2));
    return lineDist < closestDist ? line : closest;
  });
}
