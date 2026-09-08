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
  selectionRectsFromBoxes,
  stepByteOffset,
  verticalMoveTargetY,
  type AbsoluteRect,
  type CaretRect,
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

  const viewBox = parseViewBox(svg);

  // Re-derive geometry whenever the cursor/selection or the compiled
  // document changes. Byte-range query construction (`stepByteOffset`) lives
  // here rather than in `typstCursor.ts` because it needs `source` (a
  // component input) — `typstCursor.ts` stays pure geometry math.
  useEffect(() => {
    if (!source) {
      setCaretRect(null);
      setSelectionRects([]);
      return;
    }
    const selStart = Math.min(anchorOffset, cursorOffset);
    const selEnd = Math.max(anchorOffset, cursorOffset);
    const beforeStart = stepByteOffset(source, cursorOffset, "left");
    const afterEnd = stepByteOffset(source, cursorOffset, "right");

    const ranges: [number, number][] = [];
    const beforeRange: [number, number] | null = beforeStart < cursorOffset ? [beforeStart, cursorOffset] : null;
    const afterRange: [number, number] | null = cursorOffset < afterEnd ? [cursorOffset, afterEnd] : null;
    const selectionRange: [number, number] | null = selStart < selEnd ? [selStart, selEnd] : null;
    if (beforeRange) ranges.push(beforeRange);
    if (afterRange) ranges.push(afterRange);
    if (selectionRange) ranges.push(selectionRange);
    if (ranges.length === 0) {
      setCaretRect(null);
      setSelectionRects([]);
      return;
    }

    let cancelled = false;
    invoke<RawRangeBox[][]>("block_geometry", { source, baseDir: documentDir, ranges })
      .then((results) => {
        if (cancelled) return;
        let i = 0;
        const beforeBoxes = beforeRange ? results[i++] : [];
        const afterBoxes = afterRange ? results[i++] : [];
        const selectionBoxes = selectionRange ? results[i++] : [];
        setCaretRect(caretRectFromBoxes(pageOffsetsPt, beforeBoxes, afterBoxes));
        setSelectionRects(selectionRange ? selectionRectsFromBoxes(pageOffsetsPt, selectionBoxes) : []);
      })
      .catch(() => {
        if (cancelled) return;
        setCaretRect(null);
        setSelectionRects([]);
      });
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
      if (!caretRect) return;
      const xPt = preferredXPtRef.current ?? caretRect.xPt;
      preferredXPtRef.current = xPt;
      const targetY = verticalMoveTargetY(caretRect, event.key === "ArrowUp" ? "up" : "down");
      invoke<number | null>("jump_from_click", { source, xPt, yPt: targetY, baseDir: documentDir })
        .then((offset) => {
          if (offset != null) moveTo(offset, event.shiftKey);
        })
        .catch(() => {});
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
                height={caretRect.heightPt}
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
