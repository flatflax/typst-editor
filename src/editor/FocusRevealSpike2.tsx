// Phase 4 Spike 2 (doc/phase4-product-validation.md, doc/interaction-design.md
// §6/§10): Spike 1 validated the focus/blur swap for one paragraph in
// isolation. The one thing it couldn't test is the *commit-and-handoff*: what
// happens the instant a selection/drag extends past the focused block's own
// byte range and into the next one? Per §6, single-block selection is fully
// native (the browser handles it inside the textarea, free); the moment it
// crosses a block boundary, that block gets committed and control hands off
// to the self-drawn, Typst-geometry cross-block selection mechanism M20
// already proved out (`TypstLiveView.tsx`) — reused here via the same
// `block_geometry`/`jump_from_click` primitives and CSS (`.typst-live-stage`/
// `.typst-live-overlay`/`.selection-rect`), not reinvented.
//
// Two DIFFERENT rendering strategies, swapped wholesale rather than mixed:
// - "Combined" (nothing focused): ONE compile of the full two-paragraph
//   source, self-drawn selection overlay on top — exactly TypstLiveView's own
//   approach, scoped to this two-paragraph document.
// - "Split" (one block focused): the focused block becomes a real textarea in
//   normal document flow, so it growing taller pushes the other paragraph
//   down instead of overlapping it (an absolutely-positioned overlay on the
//   combined render was considered and rejected for exactly that reason —
//   nothing to push down against inside a single static image). The *other*
//   (unfocused) paragraph is NOT a second independent compile — an earlier
//   version tried that and it kept drifting out of sync with how the same
//   paragraph looks inside the combined document (page height, then
//   apparent scale — two separate compiles have no reason to agree on
//   anything not explicitly forced to match). It's a vertical crop of the
//   *same* combined SVG instead (`cropSvgVertically`): query that block's
//   own geometry, slice that band out of the already-compiled image by
//   rewriting its `viewBox`/`height`. Same pixels either way, by
//   construction — not two renderers that have to be kept consistent.
//
// Same throwaway-spike discipline as Spike 1: two fixed paragraphs, no
// keyboard navigation, no cut/copy wiring (separately scoped in
// interaction-design.md §6/§7) — only the handoff moment itself.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { EditorDiagnostic } from "./SourceEditor";
import { svgPointFromClient } from "../util/svgGeometry";
import { byteToUtf16Offset, utf16ToByteOffset } from "../util/offsets";
import { selectionRectsFromBoxes, spliceSource, type AbsoluteRect, type RawRangeBox } from "./typstCursor";

const BLOCK_A_INITIAL =
  "This is the *first* paragraph. Start a drag inside it, then keep going past its end, " +
  "down into the paragraph below.";
const BLOCK_B_INITIAL =
  "This is the *second*, adjacent paragraph — dragging into here should hand off to a real " +
  "cross-block selection, drawn on the actual compiled geometry.";

type CompileResult = {
  svg: string | null;
  diagnostics: EditorDiagnostic[];
  page_offsets_pt: number[];
};

type Props = {
  documentDir: string | null;
};

// Byte-offset (not JS-index) ranges for the two paragraphs in `source` —
// Spike 2 only ever has exactly two, split at the first blank line, so this
// doesn't need a real parse the way an N-block document eventually would
// (`parse_typst_ast`'s job, out of scope here).
function blockByteRanges(source: string): [[number, number], [number, number]] {
  const splitAt = source.indexOf("\n\n");
  const aEndUtf16 = splitAt === -1 ? source.length : splitAt;
  const bStartUtf16 = splitAt === -1 ? source.length : splitAt + 2;
  const aEnd = utf16ToByteOffset(source, aEndUtf16);
  const bStart = utf16ToByteOffset(source, bStartUtf16);
  const total = utf16ToByteOffset(source, source.length);
  return [
    [0, aEnd],
    [bStart, total],
  ];
}

function blockAt(ranges: [[number, number], [number, number]], byteOffset: number): 0 | 1 | null {
  if (byteOffset >= ranges[0][0] && byteOffset <= ranges[0][1]) return 0;
  if (byteOffset >= ranges[1][0] && byteOffset <= ranges[1][1]) return 1;
  return null;
}

function sliceByBytes(source: string, startByte: number, endByte: number): string {
  return source.slice(byteToUtf16Offset(source, startByte), byteToUtf16Offset(source, endByte));
}

function parseViewBox(svg: string | null): string | null {
  if (!svg) return null;
  const match = svg.match(/<svg[^>]*\sviewBox="([^"]+)"/);
  return match ? match[1] : null;
}

// The "other" (unfocused) block used to get its own independent, isolated
// `compile_typst` call — which, even with a `height: auto` page override,
// is still a *second compile* that has to somehow agree with how that same
// paragraph looks inside the real combined document (page width, margins,
// text defaults — anything that could differ between two separate compiles
// of the same content). Confirmed live: it didn't always agree, and read as
// "the paragraph looks smaller"/inconsistent when switching modes.
//
// Replaced with a crop of the *same* combined SVG the other mode already
// shows: query `block_geometry` for the other block's own byte range (the
// same primitive already used for cross-block selection highlights), then
// slice a band out of the combined SVG by rewriting its `viewBox`/`height`
// — the width stays untouched (full page width both times), and every
// glyph is the *same* rendered pixels as the combined view, not a second
// compile's guess at them. Zero extra `compile_typst` calls: only
// `block_geometry`, which reuses the already-compiled comemo cache for this
// exact source (compile.rs's own doc comment on `block_geometry`).
function unionYRange(rects: AbsoluteRect[]): { yTopPt: number; heightPt: number } | null {
  if (rects.length === 0) return null;
  const yTopPt = Math.min(...rects.map((r) => r.yTopPt));
  const yBottomPt = Math.max(...rects.map((r) => r.yTopPt + r.heightPt));
  return { yTopPt, heightPt: yBottomPt - yTopPt };
}

// NOT a crop tight to the block's own ink — confirmed live that reads as
// paragraphs crammed together, since it throws away the page's own top/
// bottom margins for the edge blocks *and* the natural gap between
// paragraphs entirely. Instead, each block gets its "fair share" of the
// page's vertical space: the first block's crop extends up to the actual
// page top (not just its own first line), the last block's extends down to
// the actual page bottom, and the boundary between any two adjacent blocks
// sits at the midpoint of the gap between them — reproducing the same
// spacing the combined view already has, just split at a reasonable point
// rather than guessed from nothing.
function fairShareBounds(
  idx: 0 | 1,
  rangeA: { yTopPt: number; heightPt: number },
  rangeB: { yTopPt: number; heightPt: number },
  pageHeightPt: number,
): { yTopPt: number; heightPt: number } {
  const midpoint = (rangeA.yTopPt + rangeA.heightPt + rangeB.yTopPt) / 2;
  return idx === 0 ? { yTopPt: 0, heightPt: midpoint } : { yTopPt: midpoint, heightPt: pageHeightPt - midpoint };
}

function pageDimsFromSvg(svg: string | null): { widthPt: number; heightPt: number } | null {
  const viewBox = parseViewBox(svg);
  if (!viewBox) return null;
  const parts = viewBox.trim().split(/\s+/).map(Number);
  return parts.length === 4 ? { widthPt: parts[2], heightPt: parts[3] } : null;
}

function cropSvgVertically(svg: string, yTopPt: number, heightPt: number): string | null {
  const viewBoxMatch = svg.match(/viewBox="([^"]+)"/);
  if (!viewBoxMatch) return null;
  const [minX, , width] = viewBoxMatch[1].trim().split(/\s+/).map(Number);
  let result = svg.replace(/viewBox="[^"]+"/, `viewBox="${minX} ${yTopPt} ${width} ${heightPt}"`);
  // The root `<svg>`'s own `height="...pt"` is what tells the browser the
  // *intrinsic* aspect ratio — leaving it at the full page's height while
  // the viewBox now only spans one band would stretch/squish the crop to
  // fill that taller box instead of showing it at its real proportions.
  result = result.replace(/(<svg[^>]*\sheight=")[^"]+(")/, `$1${heightPt}pt$2`);
  return result;
}

const FocusRevealSpike2 = ({ documentDir }: Props) => {
  const [source, setSource] = useState(`${BLOCK_A_INITIAL}\n\n${BLOCK_B_INITIAL}`);
  const [focusedBlock, setFocusedBlock] = useState<0 | 1 | null>(null);

  // Same fix TypstLiveView.tsx already needed for `dangerouslySetInnerHTML`:
  // replacing rendered SVG markup resets an ancestor scroll container's
  // `scrollTop` to 0 — with two blocks (and the combined/split swap on top),
  // this fires far more often here than in Spike 1's single always-present
  // block, and reads as "the focused textarea landed somewhere weird" when
  // it's really the whole view silently scrolling back to the top under it.
  // Tracks the latest scroll position on every native scroll event, restores
  // it in a *layout* effect (before paint) on every render that could have
  // replaced markup — combined SVG, the other block's SVG, or the
  // rendered/textarea swap itself.
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const lastScrollRef = useRef({ top: 0, left: 0 });

  function handleContainerScroll(event: React.UIEvent<HTMLDivElement>) {
    lastScrollRef.current = { top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft };
  }

  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (el) {
      el.scrollTop = lastScrollRef.current.top;
      el.scrollLeft = lastScrollRef.current.left;
    }
  });

  // "Combined" mode's one real compile of the whole document.
  const [combinedSvg, setCombinedSvg] = useState<string | null>(null);
  const [pageOffsetsPt, setPageOffsetsPt] = useState<number[]>([]);
  const [combinedError, setCombinedError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    invoke<CompileResult>("compile_typst", { source, baseDir: documentDir })
      .then((result) => {
        if (cancelled) return;
        setCombinedSvg(result.svg);
        setPageOffsetsPt(result.page_offsets_pt);
        setCombinedError(result.diagnostics.find((d) => d.severity === "error")?.message ?? null);
      })
      .catch((err) => {
        if (!cancelled) setCombinedError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [source, documentDir]);

  // M23's own fix (TypstLiveView.tsx), ported here for the same reason:
  // whether the currently-*displayed* `combinedSvg` actually reflects the
  // current `source` yet. Confirmed live in Spike 3 (same architecture) as
  // "clicking sometimes resolves to the wrong paragraph": a click's pixel
  // coordinates come from whatever svg is *currently rendered*, but
  // `jump_from_click` resolves them against the *current* `source` — right
  // after a commit, for one round trip, those two can disagree. The same
  // mismatch corrupts the cropped sibling too (stale pixels, fresh geometry
  // coordinates cut the wrong band out of the old image). Fixed the same
  // way M23 already did: refuse to resolve/crop until the two are back in
  // sync, rather than trusting a mix of old-image and new-document data.
  const [isPending, setIsPending] = useState(false);
  useEffect(() => {
    setIsPending(true);
  }, [source]);
  useEffect(() => {
    setIsPending(false);
  }, [combinedSvg]);

  // "Split" mode's view of whichever block ISN'T focused — a vertical crop
  // of the combined SVG (see `cropSvgVertically`'s own comment), not a
  // second compile. Needs *both* blocks' line-box geometry (not just the
  // other one's) to compute `fairShareBounds`' midpoint; the actual pixels
  // come from `combinedSvg` below.
  const [otherBlockYRange, setOtherBlockYRange] = useState<{ yTopPt: number; heightPt: number } | null>(null);
  // The *focused* block's own margins on all four sides — `fairShareBounds`
  // only ever got applied to the cropped sibling; the focused block became
  // a bare `<textarea>` with none of that page-margin spacing at all.
  // Confirmed live twice: focus the first paragraph and its real top-of-
  // page margin vanishes (vertical); separately, the textarea's width was
  // locked to the *full page width* edge-to-edge, so the text inside it
  // starts well left of — and ends well right of — where that same text
  // sits in the rendered view, which has real left/right content margins.
  // Both computed the same way: this block's own ink extent vs. the page's
  // real extent, applied as CSS margin (not padding — the gap should read
  // as blank page, not as part of the yellow "source mode" surface) and a
  // narrowed width (content width, not full page width).
  const [focusedBlockLayoutPx, setFocusedBlockLayoutPx] = useState<{
    width: number;
    marginTop: number;
    marginBottom: number;
    marginLeft: number;
    marginRight: number;
  } | null>(null);
  useEffect(() => {
    if (focusedBlock === null) return;
    const otherIdx = focusedBlock === 0 ? 1 : 0;
    const ranges = blockByteRanges(source);
    const pageDims = pageDimsFromSvg(combinedSvg);
    if (pageDims == null) return;
    let cancelled = false;
    invoke<RawRangeBox[][]>("block_geometry", { source, baseDir: documentDir, ranges: [ranges[0], ranges[1]] })
      .then((results) => {
        if (cancelled) return;
        const boxesA = results[0];
        const boxesB = results[1];
        const rangeA = unionYRange(selectionRectsFromBoxes(pageOffsetsPt, boxesA));
        const rangeB = unionYRange(selectionRectsFromBoxes(pageOffsetsPt, boxesB));
        if (!rangeA || !rangeB) {
          setOtherBlockYRange(null);
          setFocusedBlockLayoutPx(null);
          return;
        }
        setOtherBlockYRange(fairShareBounds(otherIdx, rangeA, rangeB, pageDims.heightPt));

        const focusedRange = focusedBlock === 0 ? rangeA : rangeB;
        const focusedFairShare = fairShareBounds(focusedBlock, rangeA, rangeB, pageDims.heightPt);
        // pt-to-px scale factor: the locked width (set synchronously at
        // focus time, from the combined view's own rendered width) is the
        // *full page* width in px, for the same page width in pt.
        const scale = (lockedWidthPxRef.current ?? pageDims.widthPt) / pageDims.widthPt;

        // Left/right content margins: both blocks share the same page, so
        // pooling their line boxes together (not just the focused one's)
        // gives a better chance that *some* line reaches each true margin
        // — a single short paragraph's own lines might all fall short of
        // the actual text-area width.
        const allBoxes = [...boxesA, ...boxesB];
        const contentLeftPt = allBoxes.length ? Math.min(...allBoxes.map((b) => b.x_pt)) : 0;
        const contentRightPt = allBoxes.length ? Math.max(...allBoxes.map((b) => b.x_pt + b.width_pt)) : pageDims.widthPt;

        setFocusedBlockLayoutPx({
          width: Math.max(0, (contentRightPt - contentLeftPt) * scale),
          marginLeft: Math.max(0, contentLeftPt * scale),
          marginRight: Math.max(0, (pageDims.widthPt - contentRightPt) * scale),
          marginTop: Math.max(0, (focusedRange.yTopPt - focusedFairShare.yTopPt) * scale),
          marginBottom: Math.max(
            0,
            (focusedFairShare.yTopPt + focusedFairShare.heightPt - (focusedRange.yTopPt + focusedRange.heightPt)) * scale,
          ),
        });
      })
      .catch(() => {
        if (!cancelled) {
          setOtherBlockYRange(null);
          setFocusedBlockLayoutPx(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [focusedBlock, source, documentDir, pageOffsetsPt, combinedSvg]);

  // NOT cropped while `isPending` — `combinedSvg` is still the *previous*
  // commit's pixels at that point, and `otherBlockYRange` (fetched fresh
  // against the current source) would cut the wrong band out of them.
  const otherBlockCroppedSvg =
    !isPending && combinedSvg && otherBlockYRange
      ? cropSvgVertically(combinedSvg, otherBlockYRange.yTopPt, otherBlockYRange.heightPt)
      : null;

  // Cross-block selection state (combined mode only) — refs, not state:
  // nothing renders these numbers directly, only the derived
  // `selectionRects` below needs to trigger a re-render.
  const anchorOffsetRef = useRef(0);
  const cursorOffsetRef = useRef(0);
  const [selectionRects, setSelectionRects] = useState<AbsoluteRect[]>([]);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const pendingDragPointRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const dragRequestInFlightRef = useRef(false);
  // Mirrors TypstLiveView's own mousedown-resolution race guard: a fast drag
  // can fire mousemove before mousedown's async offset lookup resolves.
  const mouseDownResolvedRef = useRef<Promise<unknown>>(Promise.resolve());

  function combinedSvgEl(): SVGSVGElement | null {
    return stageRef.current?.querySelector<SVGSVGElement>(".typst-live-svg svg") ?? null;
  }

  async function offsetAtClient(clientX: number, clientY: number): Promise<number | null> {
    if (isPending) return null;
    const base = combinedSvgEl();
    if (!base) return null;
    const { xPt, yPt } = svgPointFromClient(base, clientX, clientY);
    return invoke<number | null>("jump_from_click", { source, xPt, yPt, baseDir: documentDir }).catch(() => null);
  }

  async function updateSelectionRects(anchor: number, cursor: number) {
    const start = Math.min(anchor, cursor);
    const end = Math.max(anchor, cursor);
    if (start >= end) {
      setSelectionRects([]);
      return;
    }
    try {
      const results = await invoke<RawRangeBox[][]>("block_geometry", { source, baseDir: documentDir, ranges: [[start, end]] });
      setSelectionRects(selectionRectsFromBoxes(pageOffsetsPt, results[0]));
    } catch {
      setSelectionRects([]);
    }
  }

  // Locked width for whichever block's textarea is currently focused — same
  // fix as Spike 1, same reason: the rendered state sits at the compiled
  // page's own natural width, the textarea has none of its own. Measured
  // fresh at every transition into split mode (from a click on the combined
  // view, or from clicking straight over to the other block).
  const lockedWidthPxRef = useRef<number | null>(null);
  const draftRef = useRef("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Set once, at the drag's native mousedown inside the textarea — the fixed
  // end of the in-progress native selection, converted to an absolute byte
  // offset once the block commits (see `handoffToCombined`).
  const nativeDragAnchorUtf16Ref = useRef<number | null>(null);
  const nativeDraggingRef = useRef(false);
  // Sticky per gesture (§6, point 4): once a drag has handed off to
  // cross-block mode, it stays there until mouseup, even if the pointer
  // wanders back over the old block's screen position.
  const handedOffRef = useRef(false);

  function enterSplitMode(idx: 0 | 1, widthSourceSvg: SVGSVGElement | null) {
    const ranges = blockByteRanges(source);
    draftRef.current = sliceByBytes(source, ranges[idx][0], ranges[idx][1]);
    lockedWidthPxRef.current = widthSourceSvg?.getBoundingClientRect().width ?? null;
    handedOffRef.current = false;
    // `otherBlockYRange`/`focusedBlockLayoutPx` are shared state keyed to
    // "whichever block isn't/is focused" — without clearing them here, they
    // briefly hold the *previous* focus's values against the (already-
    // updating) combined SVG, showing the wrong band/margins until the
    // fresh geometry query resolves.
    setOtherBlockYRange(null);
    setFocusedBlockLayoutPx(null);
    setFocusedBlock(idx);
  }

  function handleCombinedMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    // Bail out entirely rather than let `offsetAtClient`'s own `isPending`
    // guard silently no-op here: if this click is refused, `draggingRef`
    // must stay false, or mouseup would reuse whatever anchor/cursor a
    // *previous* interaction left behind (still wrong, just a different
    // flavor of the same stale-vs-fresh mismatch).
    if (isPending) return;
    draggingRef.current = true;
    setSelectionRects([]);
    mouseDownResolvedRef.current = offsetAtClient(event.clientX, event.clientY).then((offset) => {
      if (offset == null) return;
      anchorOffsetRef.current = offset;
      cursorOffsetRef.current = offset;
    });
  }

  function resolveNextDragPoint() {
    const point = pendingDragPointRef.current;
    pendingDragPointRef.current = null;
    if (!point) {
      dragRequestInFlightRef.current = false;
      return;
    }
    mouseDownResolvedRef.current
      .then(() => offsetAtClient(point.clientX, point.clientY))
      .then((offset) => {
        if (offset != null) {
          cursorOffsetRef.current = offset;
          void updateSelectionRects(anchorOffsetRef.current, offset);
        }
        resolveNextDragPoint();
      });
  }

  function handleCombinedMouseMove(event: React.MouseEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    pendingDragPointRef.current = { clientX: event.clientX, clientY: event.clientY };
    if (dragRequestInFlightRef.current) return;
    dragRequestInFlightRef.current = true;
    resolveNextDragPoint();
  }

  function handleCombinedMouseUp() {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const anchor = anchorOffsetRef.current;
    const cursor = cursorOffsetRef.current;
    if (anchor === cursor) {
      const idx = blockAt(blockByteRanges(source), anchor);
      if (idx != null) enterSplitMode(idx, combinedSvgEl());
    }
  }

  // The handoff itself: a native drag inside the focused textarea has just
  // carried the pointer outside its bounding box. Commit the block, convert
  // the native selection's fixed end into an absolute byte offset against
  // the *freshly committed* source (not an approximate mapping — same
  // principle as §6's own wording), and switch to combined mode with that as
  // the new anchor. The cursor starts collapsed at the anchor for one instant
  // — the combined `<svg>` isn't mounted yet this same tick, so there's
  // nothing to convert the current pointer position against — and then
  // extends normally on the very next native mousemove, once it is.
  function handoffToCombined(idx: 0 | 1) {
    handedOffRef.current = true;
    nativeDraggingRef.current = false;
    const ranges = blockByteRanges(source);
    const [blockStart, blockEnd] = ranges[idx];
    const { source: newSource } = spliceSource(source, blockStart, blockEnd, draftRef.current);
    const anchorByte = blockStart + utf16ToByteOffset(draftRef.current, nativeDragAnchorUtf16Ref.current ?? draftRef.current.length);
    anchorOffsetRef.current = anchorByte;
    cursorOffsetRef.current = anchorByte;
    setSelectionRects([]);
    setSource(newSource);
    setFocusedBlock(null);
    draggingRef.current = true;
  }

  function handleTextareaMouseDown(event: React.MouseEvent<HTMLTextAreaElement>) {
    nativeDragAnchorUtf16Ref.current = event.currentTarget.selectionStart;
    nativeDraggingRef.current = true;
    handedOffRef.current = false;
  }

  // Watches a native in-progress drag (started inside the focused textarea)
  // for the pointer leaving its bounding box — the moment that defines "the
  // selection just crossed a block boundary" (§6).
  useEffect(() => {
    if (focusedBlock === null) return;
    const thisBlock = focusedBlock;
    function onWindowMouseMove(event: MouseEvent) {
      if (!nativeDraggingRef.current || handedOffRef.current) return;
      const el = textareaRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inside) handoffToCombined(thisBlock);
    }
    function onWindowMouseUp() {
      nativeDraggingRef.current = false;
    }
    window.addEventListener("mousemove", onWindowMouseMove);
    window.addEventListener("mouseup", onWindowMouseUp);
    return () => {
      window.removeEventListener("mousemove", onWindowMouseMove);
      window.removeEventListener("mouseup", onWindowMouseUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedBlock, source]);

  function autosize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  useLayoutEffect(() => {
    if (focusedBlock === null) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    autosize(el);
  }, [focusedBlock]);

  // Native blur (click on blank space, Tab away, Escape) — not the drag
  // handoff path above, which already committed and guards against a
  // redundant double-commit via `handedOffRef`.
  function commitEdit() {
    if (handedOffRef.current || focusedBlock === null) return;
    const ranges = blockByteRanges(source);
    const [start, end] = ranges[focusedBlock];
    const { source: newSource } = spliceSource(source, start, end, draftRef.current);
    setSource(newSource);
    setFocusedBlock(null);
  }

  // Clicking the *other*, unfocused block directly — commit the current one
  // first (its byte range must be recomputed against the just-committed
  // source, since block A's own length may have changed) and jump focus
  // straight there without detouring through combined mode.
  function switchFocusTo(idx: 0 | 1, event: React.MouseEvent<HTMLDivElement>) {
    let effectiveSource = source;
    if (focusedBlock !== null) {
      const ranges = blockByteRanges(source);
      const [s, e] = ranges[focusedBlock];
      effectiveSource = spliceSource(source, s, e, draftRef.current).source;
    }
    const newRanges = blockByteRanges(effectiveSource);
    draftRef.current = sliceByBytes(effectiveSource, newRanges[idx][0], newRanges[idx][1]);
    lockedWidthPxRef.current = event.currentTarget.querySelector("svg")?.getBoundingClientRect().width ?? null;
    handedOffRef.current = false;
    // Same reason as `enterSplitMode`: the block that's about to become
    // "other" (whichever was just focused) hasn't had its geometry queried
    // yet — without clearing these, the crop/margins briefly use the wrong
    // values.
    setOtherBlockYRange(null);
    setFocusedBlockLayoutPx(null);
    setSource(effectiveSource);
    setFocusedBlock(idx);
  }

  const viewBox = parseViewBox(combinedSvg);

  function renderTextarea() {
    return (
      <textarea
        ref={textareaRef}
        className="spike-source-textarea"
        style={
          focusedBlockLayoutPx
            ? {
                width: focusedBlockLayoutPx.width,
                marginTop: focusedBlockLayoutPx.marginTop,
                marginBottom: focusedBlockLayoutPx.marginBottom,
                marginLeft: focusedBlockLayoutPx.marginLeft,
                marginRight: focusedBlockLayoutPx.marginRight,
              }
            : lockedWidthPxRef.current != null
              ? { width: lockedWidthPxRef.current }
              : undefined
        }
        defaultValue={draftRef.current}
        onMouseDown={handleTextareaMouseDown}
        onChange={(event) => {
          draftRef.current = event.currentTarget.value;
          autosize(event.currentTarget);
        }}
        onBlur={commitEdit}
        onKeyDown={(event) => {
          if (event.key === "Escape") event.currentTarget.blur();
        }}
      />
    );
  }

  function renderOtherBlock(idx: 0 | 1) {
    return (
      <div className="spike-rendered" tabIndex={0} onClick={(event) => switchFocusTo(idx, event)} aria-label="Focus to edit source">
        {otherBlockCroppedSvg ? (
          <div className="spike-rendered-svg" dangerouslySetInnerHTML={{ __html: otherBlockCroppedSvg }} />
        ) : (
          <p className="spike-placeholder">Compiling…</p>
        )}
      </div>
    );
  }

  return (
    <div className="spike-focus-reveal" ref={scrollContainerRef} onScroll={handleContainerScroll}>
      <p className="scope-note">
        Phase 4 Spike 2: two paragraphs. Drag-select inside one, past its end, into the other — watch the commit and
        handoff to a real cross-block selection at the moment you cross the boundary. A plain click still focuses a
        single paragraph as a native textarea (Spike 1's mechanism), whichever paragraph you land in.
      </p>
      {focusedBlock === null ? (
        <div
          ref={stageRef}
          className="typst-live-stage"
          onMouseDown={handleCombinedMouseDown}
          onMouseMove={handleCombinedMouseMove}
          onMouseUp={handleCombinedMouseUp}
          onMouseLeave={handleCombinedMouseUp}
        >
          <div className="typst-live-svg" dangerouslySetInnerHTML={{ __html: combinedSvg ?? "" }} />
          {viewBox && (
            <svg className="typst-live-overlay" viewBox={viewBox}>
              {selectionRects.map((r, i) => (
                <rect key={i} x={r.xPt} y={r.yTopPt} width={r.widthPt} height={r.heightPt} className="selection-rect" />
              ))}
            </svg>
          )}
        </div>
      ) : (
        <>
          {focusedBlock === 0 ? renderTextarea() : renderOtherBlock(0)}
          {focusedBlock === 1 ? renderTextarea() : renderOtherBlock(1)}
        </>
      )}
      {combinedError && <p className="diagnostic diagnostic-error">{combinedError}</p>}
    </div>
  );
};

export default FocusRevealSpike2;
