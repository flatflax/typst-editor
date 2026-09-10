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
// line. Here `blockByteRanges` recomputes the *actual* current block count
// from `source` every time — because that recompute, at commit time, is
// the entire mechanic this spike exists to test. One consequence that
// needed real handling (not just widening `0 | 1` to `number`): clicking a
// sibling block while the currently-focused one is about to expand into
// several can shift that sibling's *index* — `switchFocusTo` relocates it by
// byte position after the commit, not by its old index.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { EditorDiagnostic } from "./SourceEditor";
import { svgPointFromClient } from "../util/svgGeometry";
import { byteToUtf16Offset, utf16ToByteOffset } from "../util/offsets";
import { selectionRectsFromBoxes, spliceSource, type AbsoluteRect, type RawRangeBox } from "./typstCursor";

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

// Split on *every* blank-line boundary (Typst's own paragraph separator),
// not just the first — unlike Spike 2, the block count here is exactly what
// this spike is testing, so it can't be assumed fixed. One or more blank
// lines collapse to a single split, matching Typst's own rule for this
// (fact-checking whether that rule also holds inside list items/table cells
// is a separate, parallel item in phase4-product-validation.md, not
// something this spike's plain top-level paragraphs need).
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

  // Fair-share Y-range for every block *except* the focused one (which is
  // instead sized via `focusedBlockLayoutPx` below) — a `Map` rather than a
  // fixed pair, since split mode can now show any number of siblings.
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
    const cropped = combinedSvg && yRange ? cropSvgVertically(combinedSvg, yRange.yTopPt, yRange.heightPt) : null;
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
