// M15a (plan.md): pure data types/helpers for the per-block render/edit
// swap. Deliberately holds no DOM/ProseMirror logic.
//
// History: an earlier NodeView-based version corrupted document content
// (wrapping paragraph/heading in extra DOM diverging from the schema's own
// `toDOM` shape confused ProseMirror's native-event reconciliation). A
// second version replaced it with absolutely-positioned per-block overlays
// (`position: fixed` + `getBoundingClientRect`), which fixed the corruption
// but reintroduced two problems computed-pixel-position overlays always
// have: the crop's Typst-native aspect ratio doesn't match the browser's
// CSS-rendered box (visible stretching), and viewport-relative positioning
// needs re-computing on every scroll.
//
// This version renders exactly two crops — everything *before* the active
// block, and everything *after* it — as plain sibling elements in normal
// document flow around the live ProseMirror block (which stays mounted,
// unmodified, showing only the active block via CSS `display: none` on its
// other top-level children). Normal flow means neither problem above can
// occur: each sibling is exactly as tall as its own content, and everything
// scrolls together in one native scroll container — see
// phase3-single-view.md's M15a entry for the full reasoning.

// A crop's rect in Typst pt units, page-1-relative (single-page scope).
export type BlockRect = {
  page: number;
  xPt: number;
  yTopPt: number;
  widthPt: number;
  heightPt: number;
};

// The raw shape `block_geometry` (compile.rs) returns per range — one entry
// per M14A `RangeBox` line/shape box, snake_case straight off the wire.
export type RawRangeBox = {
  page: number;
  x_pt: number;
  y_top_pt: number;
  width_pt: number;
  height_pt: number;
  baseline_from_top_pt: number | null;
};

// Unions a range's per-line/shape boxes into the single crop rect the
// before/after `<svg>` crops need. `null` if there's nothing on page 1 to
// union — e.g. the range is empty (active block is the very first/last
// block, so there's nothing before/after it), or (out of this slice's
// single-page scope) the content only rendered on a later page.
export function unionRangeBoxes(boxes: RawRangeBox[]): BlockRect | null {
  const page1 = boxes.filter((b) => b.page === 1);
  if (page1.length === 0) return null;
  const left = Math.min(...page1.map((b) => b.x_pt));
  const top = Math.min(...page1.map((b) => b.y_top_pt));
  const right = Math.max(...page1.map((b) => b.x_pt + b.width_pt));
  const bottom = Math.max(...page1.map((b) => b.y_top_pt + b.height_pt));
  return { page: 1, xPt: left, yTopPt: top, widthPt: right - left, heightPt: bottom - top };
}
