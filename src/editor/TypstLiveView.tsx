// M20 (plan.md): static cursor/selection/hit-testing directly on live Typst
// rendering. Click-to-position, arrow-key navigation, drag-to-select — no
// text editing, no IME (that's M21). The first milestone of the revised
// single-view mechanism (see doc/phase3-single-view.md's M15 entry) with a
// directly visible result: the whole compiled document is always shown,
// full multi-page, with a caret/selection drawn from the same geometry data
// (`block_geometry`/`geometry_for_range`, M14A) that M18 already proved can
// host CJK IME composition.
//
// Renders the compiled SVG once (unmodified) and overlays a second `<svg>`
// with the identical `viewBox`, positioned exactly on top via CSS — the
// overlay holds only the caret/selection `<rect>`s, in the same pt
// coordinate space as the base SVG, so no px conversion or resize listener
// is needed for *drawing* them (only for *hit-testing* a click, which still
// needs `getBoundingClientRect()` — see `util/svgGeometry.ts`).
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { EditorDiagnostic } from "./SourceEditor";
import { svgPointFromClient } from "../util/svgGeometry";
import {
  caretRectFromBoxes,
  lineBoxesFromRaw,
  nearestAdjacentLine,
  selectionRectsFromBoxes,
  stepByteOffset,
  type AbsoluteRect,
  type CaretRect,
  type LineBox,
  type RawRangeBox,
} from "./typstCursor";

type Props = {
  source: string;
  svg: string | null;
  pageOffsetsPt: number[];
  documentDir: string | null;
  diagnostics: EditorDiagnostic[];
};

function parseViewBox(svg: string | null): string | null {
  if (!svg) return null;
  // Cheaper than mounting into the DOM just to read one attribute back —
  // `svg_merged`'s own output always has a plain `viewBox="..."` attribute
  // on its root element (see typst-svg's `svg_header`).
  const match = svg.match(/<svg[^>]*\sviewBox="([^"]+)"/);
  return match ? match[1] : null;
}

const TypstLiveView = ({ source, svg, pageOffsetsPt, documentDir, diagnostics }: Props) => {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  // `jump_from_click` isn't on the session-held `World` (unlike
  // `block_geometry`) and a fast drag can fire far more mousemove events per
  // second than that can keep up with — without coalescing, calls would
  // stack up and could resolve out of order, making the cursor jump
  // backward transiently. Always resolves toward the *latest* pending
  // position instead of queuing a backlog.
  const pendingDragPointRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const dragRequestInFlightRef = useRef(false);
  // Sticky column for consecutive Up/Down presses (standard editor UX: moving
  // down through a short line then back up returns to the original column).
  // Reset on click/Left/Right; a ref since it shouldn't itself trigger a
  // render.
  const preferredXPtRef = useRef<number | null>(null);

  const [cursorOffset, setCursorOffset] = useState(0);
  const [anchorOffset, setAnchorOffset] = useState(0);
  const [caretRect, setCaretRect] = useState<CaretRect | null>(null);
  const [selectionRects, setSelectionRects] = useState<AbsoluteRect[]>([]);

  // `cursorOffset` state lags one render behind a rapid sequence of updates
  // (e.g. holding an arrow key, which repeats faster than React re-renders
  // land) — Up/Down navigation reads this ref instead of the state directly
  // so each keypress starts from the *actual* current position, not
  // whatever `cursorOffset` was as of this closure's last render.
  const cursorOffsetRef = useRef(cursorOffset);
  cursorOffsetRef.current = cursorOffset;

  const viewBox = parseViewBox(svg);

  // The caret geometry (before/after a given offset) — shared by the
  // reactive display effect below and by vertical navigation
  // (`drainVerticalMoveQueue`), which needs a *fresh* fetch for the offset
  // it's actually moving from rather than whatever `caretRect` state last
  // settled to (that state can be one async round-trip stale, which was
  // silently swallowing rapid Up/Down presses).
  async function fetchCaretRect(offset: number): Promise<CaretRect | null> {
    const beforeStart = stepByteOffset(source, offset, "left");
    const afterEnd = stepByteOffset(source, offset, "right");
    const beforeRange: [number, number] | null = beforeStart < offset ? [beforeStart, offset] : null;
    const afterRange: [number, number] | null = offset < afterEnd ? [offset, afterEnd] : null;
    const ranges = [beforeRange, afterRange].filter((r): r is [number, number] => r != null);
    if (ranges.length === 0) return null;
    try {
      const results = await invoke<RawRangeBox[][]>("block_geometry", { source, baseDir: documentDir, ranges });
      let i = 0;
      const beforeBoxes = beforeRange ? results[i++] : [];
      const afterBoxes = afterRange ? results[i++] : [];
      return caretRectFromBoxes(pageOffsetsPt, beforeBoxes, afterBoxes);
    } catch {
      return null;
    }
  }

  // Every line box in the document, for vertical navigation
  // (`nearestAdjacentLine`) to search — real line-spacing data, not a
  // guessed multiplier, since line spacing genuinely differs across block
  // types (headings vs. body text vs. list items). Cached per `source`
  // string so a burst of Up/Down presses (or plain repeated navigation)
  // doesn't re-fetch the whole document's geometry on every keypress; the
  // cache is naturally invalidated once the document actually changes
  // (M21) since `source` itself will differ then.
  const documentLinesCacheRef = useRef<{ source: string; lines: Promise<LineBox[]> } | null>(null);
  function fetchDocumentLines(): Promise<LineBox[]> {
    if (documentLinesCacheRef.current?.source === source) {
      return documentLinesCacheRef.current.lines;
    }
    const promise = (async () => {
      const byteLen = new TextEncoder().encode(source).length;
      if (byteLen === 0) return [];
      try {
        const results = await invoke<RawRangeBox[][]>("block_geometry", {
          source,
          baseDir: documentDir,
          ranges: [[0, byteLen]],
        });
        return lineBoxesFromRaw(pageOffsetsPt, results[0]);
      } catch {
        return [];
      }
    })();
    documentLinesCacheRef.current = { source, lines: promise };
    return promise;
  }

  // Re-derive displayed geometry whenever the cursor/selection or the
  // compiled document changes. Only responsible for what's drawn on
  // screen — vertical navigation fetches its own fresh copy (see above).
  useEffect(() => {
    if (!source) {
      setCaretRect(null);
      setSelectionRects([]);
      return;
    }
    let cancelled = false;
    fetchCaretRect(cursorOffset).then((rect) => {
      if (!cancelled) setCaretRect(rect);
    });

    const selStart = Math.min(anchorOffset, cursorOffset);
    const selEnd = Math.max(anchorOffset, cursorOffset);
    if (selStart >= selEnd) {
      setSelectionRects([]);
    } else {
      invoke<RawRangeBox[][]>("block_geometry", { source, baseDir: documentDir, ranges: [[selStart, selEnd]] })
        .then((results) => {
          if (!cancelled) setSelectionRects(selectionRectsFromBoxes(pageOffsetsPt, results[0]));
        })
        .catch(() => {
          if (!cancelled) setSelectionRects([]);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [source, cursorOffset, anchorOffset, pageOffsetsPt, documentDir]);

  function baseSvgEl(): SVGSVGElement | null {
    return stageRef.current?.querySelector<SVGSVGElement>(".typst-live-svg svg") ?? null;
  }

  function offsetAtClient(clientX: number, clientY: number): Promise<number | null> {
    const base = baseSvgEl();
    if (!base) return Promise.resolve(null);
    const { xPt, yPt } = svgPointFromClient(base, clientX, clientY);
    return invoke<number | null>("jump_from_click", { source, xPt, yPt, baseDir: documentDir }).catch(() => null);
  }

  function handleMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    stageRef.current?.focus();
    offsetAtClient(event.clientX, event.clientY).then((offset) => {
      if (offset == null) return;
      preferredXPtRef.current = null;
      setAnchorOffset(offset);
      setCursorOffset(offset);
      draggingRef.current = true;
    });
  }

  function resolveNextDragPoint() {
    const point = pendingDragPointRef.current;
    pendingDragPointRef.current = null;
    if (!point) {
      dragRequestInFlightRef.current = false;
      return;
    }
    offsetAtClient(point.clientX, point.clientY).then((offset) => {
      if (offset != null) setCursorOffset(offset);
      resolveNextDragPoint();
    });
  }

  function handleMouseMove(event: React.MouseEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    pendingDragPointRef.current = { clientX: event.clientX, clientY: event.clientY };
    if (dragRequestInFlightRef.current) return;
    dragRequestInFlightRef.current = true;
    resolveNextDragPoint();
  }

  function handleMouseUp() {
    draggingRef.current = false;
  }

  function moveTo(offset: number, extendSelection: boolean) {
    setCursorOffset(offset);
    if (!extendSelection) setAnchorOffset(offset);
  }

  // Only one vertical-move chain in flight at a time (each is two sequential
  // `invoke` calls), but unlike drag's "jump to latest position" coalescing,
  // a discrete keypress must not be dropped — holding Down should move down
  // one line per repeat, not collapse a burst of repeats into a single move.
  // A real FIFO queue, not a single "pending" slot: every press is
  // processed in order, each starting from wherever the previous one in the
  // queue landed.
  const verticalMoveQueueRef = useRef<{ direction: "up" | "down"; extend: boolean }[]>([]);
  const verticalMoveInFlightRef = useRef(false);

  async function drainVerticalMoveQueue() {
    const next = verticalMoveQueueRef.current.shift();
    if (!next) {
      verticalMoveInFlightRef.current = false;
      return;
    }
    // Fetched fresh for the *current* offset rather than reusing `caretRect`
    // state, which can still reflect the position from before this press
    // (one async round-trip behind) — using it directly here silently
    // dropped rapid Up/Down presses.
    const fromRect = await fetchCaretRect(cursorOffsetRef.current);
    if (fromRect) {
      const lines = await fetchDocumentLines();
      const target = nearestAdjacentLine(lines, fromRect.yTopPt, next.direction);
      if (target) {
        const xPt = preferredXPtRef.current ?? fromRect.xPt;
        preferredXPtRef.current = xPt;
        const targetY = target.yTopPt + target.heightPt / 2;
        const offset = await invoke<number | null>("jump_from_click", {
          source,
          xPt,
          yPt: targetY,
          baseDir: documentDir,
        }).catch(() => null);
        if (offset != null) moveTo(offset, next.extend);
      }
    }
    drainVerticalMoveQueue();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      preferredXPtRef.current = null;
      const next = stepByteOffset(source, cursorOffset, event.key === "ArrowLeft" ? "left" : "right");
      moveTo(next, event.shiftKey);
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      verticalMoveQueueRef.current.push({ direction: event.key === "ArrowUp" ? "up" : "down", extend: event.shiftKey });
      if (verticalMoveInFlightRef.current) return;
      verticalMoveInFlightRef.current = true;
      drainVerticalMoveQueue();
    }
  }

  return (
    <div className="typst-live-view">
      <p className="scope-note">
        Experimental (M20): cursor, selection, and hit-testing directly on the live Typst render — click to
        position, drag to select, arrow keys (with Shift to extend) to navigate. No typing yet — that's M21.
      </p>
      {diagnostics.map((d, i) => (
        <p key={i} className={`diagnostic diagnostic-${d.severity}`}>
          {d.severity}
          {d.line != null ? ` at ${d.line}:${d.column}` : ""}: {d.message}
        </p>
      ))}
      <div
        ref={stageRef}
        className="typst-live-stage"
        tabIndex={0}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onKeyDown={handleKeyDown}
      >
        <div className="typst-live-svg" dangerouslySetInnerHTML={{ __html: svg ?? "" }} />
        {viewBox && (
          <svg className="typst-live-overlay" viewBox={viewBox}>
            {selectionRects.map((r, i) => (
              <rect key={i} x={r.xPt} y={r.yTopPt} width={r.widthPt} height={r.heightPt} className="selection-rect" />
            ))}
            {caretRect && (
              <rect
                x={caretRect.xPt - 0.4}
                y={caretRect.yTopPt}
                width={0.8}
                height={caretRect.visualHeightPt}
                className="caret-bar"
              />
            )}
          </svg>
        )}
      </div>
    </div>
  );
};

export default TypstLiveView;
