// Phase 4 Spike 3 (doc/phase4-product-validation.md, doc/interaction-design.md
// §6/§10): Spikes 1/2 explicitly deferred this — "no lazy-vs-eager split
// debate (Spike 3)". The question here: when a focused block's draft grows
// to contain a blank line (Typst's own paragraph separator), and the user
// blurs, does reparsing the committed text into however many blocks that
// produces — the "lazy" option, §6's own stated first choice — actually feel
// right once you can see it happen? The "eager" alternative (split off each
// completed paragraph the instant its blank line is typed, keep the
// remainder focused, reuse M22's optimistic-pending visual) is deliberately
// NOT built here — try lazy first, per the doc's own priority order.
//
// Builds directly on Spike 2's architecture (combined/split rendering,
// crop-based unfocused siblings, fair-share margins) but generalizes the one
// thing Spike 2 hardcoded: exactly two blocks, split once at the first blank
// line. `blockByteRanges`/`blockAt` (./blockSplit.ts) recompute the *actual*
// current block count from `source` every time — because that recompute, at
// commit time, is the entire mechanic this spike exists to test. One
// consequence that needed real handling (not just widening `0 | 1` to
// `number`): clicking a sibling block while the currently-focused one is
// about to expand into several can shift that sibling's *index* —
// `switchFocusTo` relocates it by byte position after the commit, not by its
// old index. `blockSplit.ts` also tracks bracket depth (not just a plain
// `\n{2,}` regex) — a fact-check against the real compiler
// (phase4-product-validation.md, 2026-09-10) found a blank line inside a
// table cell doesn't end anything, unlike inside a list item, which does.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { EditorDiagnostic } from "./SourceEditor";
import { svgPointFromClient } from "../util/svgGeometry";
import { byteToUtf16Offset, utf16ToByteOffset } from "../util/offsets";
import { selectionRectsFromBoxes, spliceSource, type AbsoluteRect, type RawRangeBox } from "./typstCursor";
import { blockAt, blockByteRanges } from "./blockSplit";

const BLOCK_A_INITIAL =
  "This is the *first* paragraph. Focus it, then try typing a blank line in the middle of " +
  "your edit — like pressing Enter twice. Blur afterward and watch it split.";
const BLOCK_B_INITIAL =
  "This is the *second* paragraph, unaffected by edits to the first one, here just so there's " +
  "somewhere else to click.";

type CompileResult = {
  svg: string | null;
  diagnostics: EditorDiagnostic[];
  page_offsets_pt: number[];
};

type Props = {
  documentDir: string | null;
};

function sliceByBytes(source: string, startByte: number, endByte: number): string {
  return source.slice(byteToUtf16Offset(source, startByte), byteToUtf16Offset(source, endByte));
}

function parseViewBox(svg: string | null): string | null {
  if (!svg) return null;
  const match = svg.match(/<svg[^>]*\sviewBox="([^"]+)"/);
  return match ? match[1] : null;
}

function unionYRange(rects: AbsoluteRect[]): { yTopPt: number; heightPt: number } | null {
  if (rects.length === 0) return null;
  const yTopPt = Math.min(...rects.map((r) => r.yTopPt));
  const yBottomPt = Math.max(...rects.map((r) => r.yTopPt + r.heightPt));
  return { yTopPt, heightPt: yBottomPt - yTopPt };
}

// Generalized from Spike 2's two-block special case: block `idx`'s "fair
// share" of the page's vertical space extends up to the true page top (if
// it's first) or the midpoint with its previous neighbor, and down to the
// true page bottom (if it's last) or the midpoint with its next neighbor —
// needs every block's own ink range (not just its neighbors') since the
// array itself is what identifies who those neighbors are.
function fairShareBoundsForIndex(
  idx: number,
  ownRanges: { yTopPt: number; heightPt: number }[],
  pageHeightPt: number,
): { yTopPt: number; heightPt: number } {
  const prev = ownRanges[idx - 1];
  const next = ownRanges[idx + 1];
  const top = prev ? (prev.yTopPt + prev.heightPt + ownRanges[idx].yTopPt) / 2 : 0;
  const bottom = next ? (ownRanges[idx].yTopPt + ownRanges[idx].heightPt + next.yTopPt) / 2 : pageHeightPt;
  return { yTopPt: top, heightPt: bottom - top };
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
  result = result.replace(/(<svg[^>]*\sheight=")[^"]+(")/, `$1${heightPt}pt$2`);
  return result;
}

const FocusRevealSpike3 = ({ documentDir }: Props) => {
  const [source, setSource] = useState(`${BLOCK_A_INITIAL}\n\n${BLOCK_B_INITIAL}`);
  const [focusedBlock, setFocusedBlock] = useState<number | null>(null);

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

  // M23's own fix (TypstLiveView.tsx), needed here for the same reason:
  // whether the currently-*displayed* `combinedSvg` actually reflects the
  // current `source` yet. Confirmed live as "clicking sometimes resolves to
  // the wrong paragraph": a click's pixel coordinates come from whatever
  // svg is *currently rendered* (`combinedSvgEl()`), but `jump_from_click`
  // resolves them against the *current* `source` — right after a commit,
  // for one round trip, those two can disagree (stale pixels, fresh
  // document), silently landing on the wrong text. The same mismatch
  // corrupts a cropped sibling too: cropping stale pixels with fresh
  // geometry coordinates cuts the wrong band out of the (old) image. Not a
  // caching bug in the usual sense — the fix is the same one M23 already
  // found: refuse to resolve/crop until the two are back in sync, rather
  // than trusting a mix of old-image-coordinates and new-document-geometry.
  const [isPending, setIsPending] = useState(false);
  useEffect(() => {
    setIsPending(true);
  }, [source]);
  useEffect(() => {
    setIsPending(false);
  }, [combinedSvg]);

  // Fair-share Y-range for every block *except* the focused one (which is
  // instead sized via `focusedBlockLayoutPx` below) — a `Map` rather than a
  // fixed pair, since split mode can now show any number of siblings.
  const [otherBlocksYRanges, setOtherBlocksYRanges] = useState<Map<number, { yTopPt: number; heightPt: number }>>(
    new Map(),
  );
  type FocusedLayoutPx = {
    width: number;
    marginTop: number;
    marginBottom: number;
    marginLeft: number;
    marginRight: number;
  };
  const [focusedBlockLayoutPx, setFocusedBlockLayoutPx] = useState<FocusedLayoutPx | null>(null);

  // Computes the split-mode layout (fair-share crops for siblings, textarea
  // width/margins for the focused block) *before* any state changes — found
  // live (2026-09-10, phase4-product-validation.md) that doing this as a
  // reactive effect keyed on `focusedBlock` produced a visible stutter on
  // every focus-entry: the first render (state already flipped, geometry
  // not back yet) showed no margins and "Compiling…" siblings, then a
  // second render corrected it once this round trip landed. Callers now
  // await this and set all three states together, so split mode's first
  // frame is already correct.
  async function computeSplitLayout(
    effectiveSource: string,
    idx: number,
  ): Promise<{ otherMap: Map<number, { yTopPt: number; heightPt: number }>; focusedLayoutPx: FocusedLayoutPx } | null> {
    const ranges = blockByteRanges(effectiveSource);
    const pageDims = pageDimsFromSvg(combinedSvg);
    if (pageDims == null) return null;
    let results: RawRangeBox[][];
    try {
      results = await invoke<RawRangeBox[][]>("block_geometry", { source: effectiveSource, baseDir: documentDir, ranges });
    } catch {
      return null;
    }
    const ownRanges = results.map((boxes) => unionYRange(selectionRectsFromBoxes(pageOffsetsPt, boxes)));
    if (ownRanges.some((r) => r == null) || idx >= ownRanges.length) return null;
    const validRanges = ownRanges as { yTopPt: number; heightPt: number }[];

    const otherMap = new Map<number, { yTopPt: number; heightPt: number }>();
    for (let i = 0; i < validRanges.length; i++) {
      if (i === idx) continue;
      otherMap.set(i, fairShareBoundsForIndex(i, validRanges, pageDims.heightPt));
    }

    const focusedRange = validRanges[idx];
    const focusedFairShare = fairShareBoundsForIndex(idx, validRanges, pageDims.heightPt);
    const scale = (lockedWidthPxRef.current ?? pageDims.widthPt) / pageDims.widthPt;
    const allBoxes = results.flat();
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

  const anchorOffsetRef = useRef(0);
  const cursorOffsetRef = useRef(0);
  const [selectionRects, setSelectionRects] = useState<AbsoluteRect[]>([]);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const pendingDragPointRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const dragRequestInFlightRef = useRef(false);
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

  const lockedWidthPxRef = useRef<number | null>(null);
  const draftRef = useRef("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const nativeDragAnchorUtf16Ref = useRef<number | null>(null);
  const nativeDraggingRef = useRef(false);
  const draggedOutsideRef = useRef(false);
  const lastMouseClientRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const handedOffRef = useRef(false);

  async function enterSplitMode(idx: number, widthSourceSvg: SVGSVGElement | null) {
    const ranges = blockByteRanges(source);
    lockedWidthPxRef.current = widthSourceSvg?.getBoundingClientRect().width ?? null;
    const layout = await computeSplitLayout(source, idx);
    draftRef.current = sliceByBytes(source, ranges[idx][0], ranges[idx][1]);
    handedOffRef.current = false;
    setOtherBlocksYRanges(layout?.otherMap ?? new Map());
    setFocusedBlockLayoutPx(layout?.focusedLayoutPx ?? null);
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
      if (idx != null) void enterSplitMode(idx, combinedSvgEl());
    }
  }

  // Resolves where a drag that continued out of the textarea and was
  // released in combined-mode territory should land — but only once *every*
  // sign that this specific commit has fully landed agrees: we're back in
  // combined mode (`focusedBlock`), `source` itself is the exact string we
  // committed (not still mid-batch), and no recompile is in flight
  // (`isPending`). Declarative rather than tracking the isPending true→false
  // transition by hand: `source` changing to the committed value and
  // `isPending` becoming true are two *separate* state updates (the second
  // is itself effect-driven off the first), so checking "isPending is
  // currently false" immediately after the commit is unreliable — it can
  // still read as false for a render or two before the recompile it's
  // supposed to be guarding has even started. Re-checking all three
  // conditions on every relevant change avoids needing to know *which*
  // update was the one that finally satisfied them.
  async function resolveHandoffDrop(pending: { anchorByte: number; clientX: number; clientY: number }) {
    const base = combinedSvgEl();
    if (!base) return;
    const { xPt, yPt } = svgPointFromClient(base, pending.clientX, pending.clientY);
    const offset = await invoke<number | null>("jump_from_click", { source, xPt, yPt, baseDir: documentDir }).catch(
      () => null,
    );
    if (offset == null) return;
    anchorOffsetRef.current = pending.anchorByte;
    cursorOffsetRef.current = offset;
    void updateSelectionRects(pending.anchorByte, offset);
  }

  const pendingHandoffResolutionRef = useRef<{
    anchorByte: number;
    clientX: number;
    clientY: number;
    expectedSource: string;
  } | null>(null);
  useEffect(() => {
    const pending = pendingHandoffResolutionRef.current;
    if (!pending) return;
    if (focusedBlock !== null) return;
    if (source !== pending.expectedSource) return;
    if (isPending) return;
    pendingHandoffResolutionRef.current = null;
    void resolveHandoffDrop(pending);
  }, [focusedBlock, source, isPending]);

  function handleTextareaMouseDown(event: React.MouseEvent<HTMLTextAreaElement>) {
    nativeDragAnchorUtf16Ref.current = event.currentTarget.selectionStart;
    nativeDraggingRef.current = true;
    draggedOutsideRef.current = false;
    lastMouseClientRef.current = null;
    handedOffRef.current = false;
  }

  // Deliberately does *not* live-update a cross-block selection while the
  // mouse is still outside the textarea mid-drag (interaction-design.md §6:
  // "which mode a drag/shift-select gesture is in is decided once, at the
  // gesture's end, not switched back and forth mid-gesture" — an existing
  // design decision this used to violate). Found live (2026-09-10,
  // phase4-product-validation.md): live-updating requires converting the
  // *same* screen position through two different coordinate systems in
  // quick succession — the native textarea's own font/line-height, and
  // Typst's real SVG layout for the identical text, which are never
  // pixel-identical — so a drag that visually looked like it was still
  // inside block B's text could numerically already be past the last real
  // glyph, in blank page space, where `jump_from_click` legitimately (and
  // permanently, for the rest of that gesture) returns no target. Resolving
  // only once, at mouseup, against the mouse's one final position and one
  // fresh render, sidesteps the whole class of mid-drag coordinate drift —
  // there is no "intermediate" position to get wrong.
  useEffect(() => {
    if (focusedBlock === null) return;
    const thisBlock = focusedBlock;
    function onWindowMouseMove(event: MouseEvent) {
      if (!nativeDraggingRef.current || handedOffRef.current) return;
      lastMouseClientRef.current = { clientX: event.clientX, clientY: event.clientY };
      const el = textareaRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inside) draggedOutsideRef.current = true;
    }
    function onWindowMouseUp() {
      const wasDragging = nativeDraggingRef.current;
      nativeDraggingRef.current = false;
      if (!wasDragging || !draggedOutsideRef.current) return;
      draggedOutsideRef.current = false;
      const dropPoint = lastMouseClientRef.current;
      lastMouseClientRef.current = null;
      if (!dropPoint) return;

      handedOffRef.current = true;
      const ranges = blockByteRanges(source);
      const [blockStart, blockEnd] = ranges[thisBlock];
      const { source: newSource } = spliceSource(source, blockStart, blockEnd, draftRef.current);
      const anchorByte =
        blockStart + utf16ToByteOffset(draftRef.current, nativeDragAnchorUtf16Ref.current ?? draftRef.current.length);

      setSelectionRects([]);
      setSource(newSource);
      setFocusedBlock(null);
      // Always deferred to the effect above — even when `newSource` is
      // identical to `source` (nothing typed, just a plain drag) this still
      // needs at least one render for `focusedBlock` to actually reach the
      // DOM as null (`stageRef` isn't attached to anything yet in this same
      // synchronous handler); the effect's conditions are already trivially
      // satisfied in that case, so it resolves on the very next render.
      pendingHandoffResolutionRef.current = {
        anchorByte,
        clientX: dropPoint.clientX,
        clientY: dropPoint.clientY,
        expectedSource: newSource,
      };
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

  // Native blur — the mechanic this whole spike exists to test. The draft
  // may now contain its own blank line(s); `blockByteRanges` on the freshly
  // committed source naturally reports however many blocks that produces,
  // whether that's the same count as before, more, or (an emptied block)
  // fewer. Nothing else here needs to know the difference — every other
  // consumer of "how many blocks, which one is which" already recomputes
  // fresh from `source` rather than trusting a remembered count.
  function commitEdit() {
    if (handedOffRef.current || focusedBlock === null) return;
    const ranges = blockByteRanges(source);
    const [start, end] = ranges[focusedBlock];
    const { source: newSource } = spliceSource(source, start, end, draftRef.current);
    setSource(newSource);
    setFocusedBlock(null);
  }

  // Clicking a sibling block directly. Committing the currently-focused
  // block first can change *how many* blocks exist before this one — the
  // sibling just clicked might no longer be at the index it was rendered
  // at. Relocates it by byte position instead: capture where it started
  // *before* the commit, shift that position by the focused block's own
  // length delta (only if the sibling came after it), then find whichever
  // fresh block now contains that (possibly shifted) position.
  async function switchFocusTo(oldIdx: number, event: React.MouseEvent<HTMLDivElement>) {
    const oldRanges = blockByteRanges(source);
    let effectiveSource = source;
    let targetByte = oldRanges[oldIdx][0];
    if (focusedBlock !== null) {
      const [s, e] = oldRanges[focusedBlock];
      const oldLenBytes = e - s;
      const spliced = spliceSource(source, s, e, draftRef.current);
      effectiveSource = spliced.source;
      const newLenBytes = utf16ToByteOffset(draftRef.current, draftRef.current.length);
      if (targetByte > s) targetByte += newLenBytes - oldLenBytes;
    }
    const newRanges = blockByteRanges(effectiveSource);
    const newIdx = blockAt(newRanges, targetByte) ?? Math.min(oldIdx, newRanges.length - 1);
    // Read before the `await` below — React nulls out `currentTarget` on a
    // synthetic event once its handler returns synchronously.
    lockedWidthPxRef.current = event.currentTarget.querySelector("svg")?.getBoundingClientRect().width ?? null;
    const layout = await computeSplitLayout(effectiveSource, newIdx);
    draftRef.current = sliceByBytes(effectiveSource, newRanges[newIdx][0], newRanges[newIdx][1]);
    handedOffRef.current = false;
    setOtherBlocksYRanges(layout?.otherMap ?? new Map());
    setFocusedBlockLayoutPx(layout?.focusedLayoutPx ?? null);
    setSource(effectiveSource);
    setFocusedBlock(newIdx);
  }

  const viewBox = parseViewBox(combinedSvg);

  function renderTextarea(key: number) {
    return (
      <textarea
        key={key}
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

  function renderOtherBlock(idx: number) {
    const yRange = otherBlocksYRanges.get(idx);
    // NOT cropped while `isPending` — `combinedSvg` is still the *previous*
    // commit's pixels at that point, and `yRange` (fetched fresh against
    // the current source) would cut the wrong band out of them.
    const cropped = !isPending && combinedSvg && yRange ? cropSvgVertically(combinedSvg, yRange.yTopPt, yRange.heightPt) : null;
    return (
      <div
        key={idx}
        className="spike-rendered"
        tabIndex={0}
        onClick={(event) => switchFocusTo(idx, event)}
        aria-label="Focus to edit source"
      >
        {cropped ? (
          <div className="spike-rendered-svg" dangerouslySetInnerHTML={{ __html: cropped }} />
        ) : (
          <p className="spike-placeholder">Compiling…</p>
        )}
      </div>
    );
  }

  return (
    <div className="spike-focus-reveal" ref={scrollContainerRef} onScroll={handleContainerScroll}>
      <p className="scope-note">
        Phase 4 Spike 3: focus a paragraph, type a blank line in the middle of your edit (Enter twice), then click or
        Tab away — the "lazy" mechanic (interaction-design.md §6): nothing is re-parsed while you type, only the
        committed draft, at blur, split into however many paragraphs it now contains.
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
        blockByteRanges(source).map((_, i) => (i === focusedBlock ? renderTextarea(i) : renderOtherBlock(i)))
      )}
      {combinedError && <p className="diagnostic diagnostic-error">{combinedError}</p>}
    </div>
  );
};

export default FocusRevealSpike3;
