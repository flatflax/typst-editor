// Phase 4 Spike 3 (eager variant) — doc/phase4-product-validation.md,
// doc/interaction-design.md §6/§10. `FocusRevealSpike3.tsx` built the "lazy"
// half (reparse into N blocks only at blur); this is the "eager" half §6
// describes as the follow-up comparison: the instant a complete blank-line
// separator appears in the focused draft, split off the completed part
// immediately — no waiting for blur — and keep typing in the (now shorter)
// remainder, still focused.
//
// The split-off part reuses M22's optimistic-pending convention essentially
// for free: the moment `source` is spliced, `isPending` goes true (same
// flag Spike 3 already needed to fix the stale-image click bug), and the
// crop-rendering already refuses to crop while pending — so the
// newly-completed block shows the same "Compiling…" placeholder any other
// not-yet-compiled sibling does, then swaps to its real cropped rendering
// the moment the fresh compile lands. No separate pending-visual machinery
// needed beyond what Spike 3 already has.
//
// Cursor handling relies on React's own reconciliation rather than manual
// DOM surgery: bumping `focusedBlock` by however many new blocks the split
// produced means the array position that used to hold non-textarea content
// now renders `<textarea>` there instead — a different element type at that
// key, so React unmounts the old node and mounts a fresh one with
// `defaultValue` already set to the trimmed remainder, and the existing
// focus/cursor-placement effect (already needed for plain click-to-focus)
// runs again for free, landing the caret at the end of what's left.
//
// Same architecture as the lazy variant otherwise (combined/split
// rendering, crop-based unfocused siblings, fair-share margins, the
// isPending click-safety fix) — only `renderTextarea`'s `onChange` differs.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { EditorDiagnostic } from "./SourceEditor";
import { svgPointFromClient } from "../util/svgGeometry";
import { byteToUtf16Offset, utf16ToByteOffset } from "../util/offsets";
import { selectionRectsFromBoxes, spliceSource, type AbsoluteRect, type RawRangeBox } from "./typstCursor";

const BLOCK_A_INITIAL =
  "This is the *first* paragraph. Focus it, then try typing a blank line in the middle of " +
  "your edit — like pressing Enter twice. Watch it split off immediately, no need to blur.";
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

function blockByteRanges(source: string): [number, number][] {
  const ranges: [number, number][] = [];
  const blankLine = /\n{2,}/g;
  let lastEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = blankLine.exec(source))) {
    ranges.push([utf16ToByteOffset(source, lastEnd), utf16ToByteOffset(source, match.index)]);
    lastEnd = match.index + match[0].length;
  }
  ranges.push([utf16ToByteOffset(source, lastEnd), utf16ToByteOffset(source, source.length)]);
  return ranges;
}

function blockAt(ranges: [number, number][], byteOffset: number): number | null {
  for (let i = 0; i < ranges.length; i++) {
    if (byteOffset >= ranges[i][0] && byteOffset <= ranges[i][1]) return i;
  }
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

function unionYRange(rects: AbsoluteRect[]): { yTopPt: number; heightPt: number } | null {
  if (rects.length === 0) return null;
  const yTopPt = Math.min(...rects.map((r) => r.yTopPt));
  const yBottomPt = Math.max(...rects.map((r) => r.yTopPt + r.heightPt));
  return { yTopPt, heightPt: yBottomPt - yTopPt };
}

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

// The eager mechanic's own primitive: does the draft now contain a
// *complete* blank-line separator? Splits at the *last* one, so a paste
// containing several at once still leaves only the true tail still being
// typed as "remaining" — everything before it, blank lines included, is
// "completed" and gets spliced into `source` immediately.
//
// Requires `remaining` to be non-empty (real content, not just whitespace)
// — confirmed live this is not optional. Splicing `completed + "\n\n" + ""`
// back in puts an *empty* would-be paragraph directly against whatever
// separator already followed the old block, producing a run of 4+
// consecutive newlines. Typst collapses any run of blank lines into a
// single paragraph break (this spike's own `blockByteRanges` mirrors that
// with `\n{2,}`, greedy), so that "empty paragraph" isn't a real, separate
// block at all — it silently merges with the *next* real paragraph. The
// textarea then gets focused on that merged slot, and typing into it
// overwrites the next paragraph's actual content once committed. Waiting
// for at least one real character in `remaining` guarantees the split
// always produces a genuinely distinct block, never an empty one that
// Typst (and this function's own regex) wouldn't recognize as separate.
function trySplitOffCompleted(draft: string): { completed: string; remaining: string } | null {
  const blankLine = /\n{2,}/g;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = blankLine.exec(draft))) lastMatch = match;
  if (!lastMatch) return null;
  const remaining = draft.slice(lastMatch.index + lastMatch[0].length);
  if (remaining.trim() === "") return null;
  return {
    completed: draft.slice(0, lastMatch.index),
    remaining,
  };
}

const FocusRevealSpike3Eager = ({ documentDir }: Props) => {
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

  const [isPending, setIsPending] = useState(false);
  useEffect(() => {
    setIsPending(true);
  }, [source]);
  useEffect(() => {
    setIsPending(false);
  }, [combinedSvg]);

  const [otherBlocksYRanges, setOtherBlocksYRanges] = useState<Map<number, { yTopPt: number; heightPt: number }>>(
    new Map(),
  );
  const [focusedBlockLayoutPx, setFocusedBlockLayoutPx] = useState<{
    width: number;
    marginTop: number;
    marginBottom: number;
    marginLeft: number;
    marginRight: number;
  } | null>(null);
  useEffect(() => {
    if (focusedBlock === null) return;
    const ranges = blockByteRanges(source);
    const pageDims = pageDimsFromSvg(combinedSvg);
    if (pageDims == null) return;
    let cancelled = false;
    invoke<RawRangeBox[][]>("block_geometry", { source, baseDir: documentDir, ranges })
      .then((results) => {
        if (cancelled) return;
        const ownRanges = results.map((boxes) => unionYRange(selectionRectsFromBoxes(pageOffsetsPt, boxes)));
        if (ownRanges.some((r) => r == null) || focusedBlock >= ownRanges.length) {
          setOtherBlocksYRanges(new Map());
          setFocusedBlockLayoutPx(null);
          return;
        }
        const validRanges = ownRanges as { yTopPt: number; heightPt: number }[];

        const otherMap = new Map<number, { yTopPt: number; heightPt: number }>();
        for (let i = 0; i < validRanges.length; i++) {
          if (i === focusedBlock) continue;
          otherMap.set(i, fairShareBoundsForIndex(i, validRanges, pageDims.heightPt));
        }
        setOtherBlocksYRanges(otherMap);

        const focusedRange = validRanges[focusedBlock];
        const focusedFairShare = fairShareBoundsForIndex(focusedBlock, validRanges, pageDims.heightPt);
        const scale = (lockedWidthPxRef.current ?? pageDims.widthPt) / pageDims.widthPt;
        const allBoxes = results.flat();
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
          setOtherBlocksYRanges(new Map());
          setFocusedBlockLayoutPx(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [focusedBlock, source, documentDir, pageOffsetsPt, combinedSvg]);

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
  const handedOffRef = useRef(false);

  function enterSplitMode(idx: number, widthSourceSvg: SVGSVGElement | null) {
    const ranges = blockByteRanges(source);
    draftRef.current = sliceByBytes(source, ranges[idx][0], ranges[idx][1]);
    lockedWidthPxRef.current = widthSourceSvg?.getBoundingClientRect().width ?? null;
    handedOffRef.current = false;
    setOtherBlocksYRanges(new Map());
    setFocusedBlockLayoutPx(null);
    setFocusedBlock(idx);
  }

  function handleCombinedMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault();
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

  function handoffToCombined(idx: number) {
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

  // Still needed for blur via Tab/click-to-blank-space/Escape — the eager
  // split below handles blank lines typed *while still focused*; this
  // covers committing whatever's left in the (by then blank-line-free)
  // remainder once focus actually leaves.
  function commitEdit() {
    if (handedOffRef.current || focusedBlock === null) return;
    const ranges = blockByteRanges(source);
    const [start, end] = ranges[focusedBlock];
    const { source: newSource } = spliceSource(source, start, end, draftRef.current);
    setSource(newSource);
    setFocusedBlock(null);
  }

  function switchFocusTo(oldIdx: number, event: React.MouseEvent<HTMLDivElement>) {
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
    draftRef.current = sliceByBytes(effectiveSource, newRanges[newIdx][0], newRanges[newIdx][1]);
    lockedWidthPxRef.current = event.currentTarget.querySelector("svg")?.getBoundingClientRect().width ?? null;
    handedOffRef.current = false;
    setOtherBlocksYRanges(new Map());
    setFocusedBlockLayoutPx(null);
    setSource(effectiveSource);
    setFocusedBlock(newIdx);
  }

  // The eager mechanic itself: on every keystroke, check whether the draft
  // now contains a complete blank-line separator. If so, splice everything
  // up to (and including) it into `source` right now — as its own real
  // committed block(s), not a draft — and keep only the tail as the still-
  // focused draft. `focusedBlock` bumps by however many separators were in
  // the completed part (almost always one, but a multi-paragraph paste
  // could contain several at once) so it keeps pointing at the block that's
  // actually still being edited, wherever the array shifted it to.
  function handleTextareaChange(event: React.FormEvent<HTMLTextAreaElement>) {
    const value = event.currentTarget.value;
    const split = trySplitOffCompleted(value);
    if (split && focusedBlock !== null) {
      const ranges = blockByteRanges(source);
      const [start, end] = ranges[focusedBlock];
      const { source: newSource } = spliceSource(source, start, end, `${split.completed}\n\n${split.remaining}`);
      const blocksInserted = split.completed.split(/\n{2,}/).length;
      draftRef.current = split.remaining;
      setSource(newSource);
      setFocusedBlock(focusedBlock + blocksInserted);
      return;
    }
    draftRef.current = value;
    autosize(event.currentTarget);
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
        onChange={handleTextareaChange}
        onBlur={commitEdit}
        onKeyDown={(event) => {
          if (event.key === "Escape") event.currentTarget.blur();
        }}
      />
    );
  }

  function renderOtherBlock(idx: number) {
    const yRange = otherBlocksYRanges.get(idx);
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
        Phase 4 Spike 3 (eager variant): focus a paragraph, type a blank line in the middle of your edit (Enter
        twice) — the completed part splits off and commits immediately, showing "Compiling…" until the real render
        catches up, while you keep typing the remainder in the same focused textarea. Compare the feel of this
        against the "lazy" tab (waits until you blur).
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

export default FocusRevealSpike3Eager;
