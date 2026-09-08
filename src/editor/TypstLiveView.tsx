// M20/M21 (plan.md): static cursor/selection/hit-testing, plus (M21) a real
// edit loop, directly on live Typst rendering. The first milestone of the
// revised single-view mechanism (see doc/phase3-single-view.md's M15 entry)
// with a directly visible result: the whole compiled document is always
// shown, full multi-page, with a caret/selection drawn from the same
// geometry data (`block_geometry`/`geometry_for_range`, M14A) that M18
// already proved can host CJK IME composition.
//
// Renders the compiled SVG once (unmodified) and overlays a second `<svg>`
// with the identical `viewBox`, positioned exactly on top via CSS — the
// overlay holds only the caret/selection `<rect>`s, in the same pt
// coordinate space as the base SVG, so no px conversion or resize listener
// is needed for *drawing* them (only for *hit-testing* a click, which still
// needs `getBoundingClientRect()` — see `util/svgGeometry.ts`).
//
// M21 typing model: a hidden `<textarea>` captures keystrokes and IME
// composition (matching M18's validated harness — `input`/`compositionend`
// events, not `keydown`, so IME composition machinery works correctly). No
// live composition overlay yet — a composing IME shows nothing on screen
// until `compositionend` commits it, unlike M18's own harness. Deferred as
// a known limitation, not solved here: it needs the same live-overlay
// technique M18 validated, wired to the real compiled document instead of a
// static sample.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { EditorDiagnostic } from "./SourceEditor";
import { svgPointFromClient } from "../util/svgGeometry";
import {
  caretRectFromBoxes,
  clampXToLine,
  lineContainingY,
  nearestAdjacentLine,
  RECOMPILE_DEBOUNCE_MS,
  selectionRectsFromBoxes,
  spliceSource,
  stepByteOffset,
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
  onChange: (source: string) => void;
};

// `block_geometry` (compile.rs) runs its own full `typst::compile` call
// internally — it walks a *compiled* document's Frame tree, and doesn't
// reuse whatever `compile_typst`'s own debounced call already produced.
// Refetching caret/selection geometry on every keystroke without a matching
// debounce would silently force a full recompile per keystroke, defeating
// the entire point of debouncing `compile_typst` in the first place. Shares
// `RECOMPILE_DEBOUNCE_MS` with `App.tsx`'s own compile debounce so both
// settle at roughly the same moment; cursor/selection-only changes (pure
// navigation, `source` unchanged) skip this delay entirely —
// `block_geometry`'s compile call is then a comemo cache hit (near-free,
// M14), and navigation stays instant.

function parseViewBox(svg: string | null): string | null {
  if (!svg) return null;
  // Cheaper than mounting into the DOM just to read one attribute back —
  // `svg_merged`'s own output always has a plain `viewBox="..."` attribute
  // on its root element (see typst-svg's `svg_header`).
  const match = svg.match(/<svg[^>]*\sviewBox="([^"]+)"/);
  return match ? match[1] : null;
}

const TypstLiveView = ({ source, svg, pageOffsetsPt, documentDir, diagnostics, onChange }: Props) => {
  // Replacing `.typst-live-svg`'s `innerHTML` on every recompile (below)
  // reset this scroll container back to the top on a long, actually-
  // scrolled document — found live-testing a 20-section multi-page
  // document. Not investigated down to the exact browser mechanism; fixed
  // defensively instead, by tracking the latest scroll position on every
  // native scroll event and restoring it in a *layout* effect (runs
  // synchronously after the DOM commit but before the browser paints) keyed
  // on `svg`, so any reset that happens during that commit is corrected
  // before the user can see it.
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
  }, [svg]);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const hiddenInputRef = useRef<HTMLTextAreaElement | null>(null);
  // Tracks composition state ourselves rather than trusting a single
  // `InputEvent.isComposing` check — Chromium fires the terminal `input`
  // event for a composition emptied via backspace with `isComposing:false`,
  // ~0.3ms *before* `compositionend` actually fires (found live-testing
  // M18's harness). Trusting that one event's flag there deletes a
  // character from already-committed content instead of letting the
  // cancelled composition vanish harmlessly.
  const composingRef = useRef(false);
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
  //
  // A 1-character window either side of `offset` first (cheap, the common
  // case). Typst renders no ink for bare whitespace, so that narrow window
  // finds nothing when the cursor sits on a blank line/empty paragraph —
  // not a rare case, since Enter creates exactly that (a blank line) — and
  // without a fallback the caret would just vanish there entirely, even
  // though the position itself is perfectly real. Widens to a few hundred
  // bytes either side in that case so the caret still lands near the
  // nearest actual content — an approximation (there's nothing at the
  // blank line itself to measure), but far better than no caret at all.
  async function fetchCaretRect(offset: number): Promise<CaretRect | null> {
    const narrow = await fetchCaretRectInWindow(offset, 1);
    if (narrow) return narrow;
    return fetchCaretRectInWindow(offset, 256);
  }

  async function fetchCaretRectInWindow(offset: number, windowBytes: number): Promise<CaretRect | null> {
    const beforeStart =
      windowBytes === 1 ? stepByteOffset(source, offset, "left") : Math.max(0, offset - windowBytes);
    const afterEnd =
      windowBytes === 1
        ? stepByteOffset(source, offset, "right")
        : Math.min(new TextEncoder().encode(source).length, offset + windowBytes);
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
  const documentLinesCacheRef = useRef<{ source: string; lines: Promise<AbsoluteRect[]> } | null>(null);
  function fetchDocumentLines(): Promise<AbsoluteRect[]> {
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
        return selectionRectsFromBoxes(pageOffsetsPt, results[0]);
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
  // Debounced (`RECOMPILE_DEBOUNCE_MS`) specifically when `source` itself
  // just changed (typing); immediate for a pure cursor/selection move with
  // the same `source` (navigation) — see the import's own comment above for why
  // the two cases need different treatment.
  const lastGeometrySourceRef = useRef(source);
  useEffect(() => {
    if (!source) {
      setCaretRect(null);
      setSelectionRects([]);
      lastGeometrySourceRef.current = source;
      return;
    }

    let cancelled = false;
    function runFetch() {
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
    }

    const sourceChanged = lastGeometrySourceRef.current !== source;
    lastGeometrySourceRef.current = source;

    if (sourceChanged) {
      const timer = setTimeout(runFetch, RECOMPILE_DEBOUNCE_MS);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }
    runFetch();
    return () => {
      cancelled = true;
    };
  }, [source, cursorOffset, anchorOffset, pageOffsetsPt, documentDir]);

  function baseSvgEl(): SVGSVGElement | null {
    return stageRef.current?.querySelector<SVGSVGElement>(".typst-live-svg svg") ?? null;
  }

  async function offsetAtClient(clientX: number, clientY: number): Promise<number | null> {
    const base = baseSvgEl();
    if (!base) return null;
    const { xPt, yPt } = svgPointFromClient(base, clientX, clientY);
    const direct = await invoke<number | null>("jump_from_click", { source, xPt, yPt, baseDir: documentDir }).catch(
      () => null,
    );
    if (direct != null) return direct;
    // Clicked blank space (past a short line's end, below the last line,
    // in the margins, in the gap between lines) — jump_from_click found no
    // content exactly there. Snap to the nearest actual line instead of
    // leaving the click with no effect.
    const lines = await fetchDocumentLines();
    const nearestLine = lineContainingY(lines, yPt);
    if (!nearestLine) return null;
    return invoke<number | null>("jump_from_click", {
      source,
      xPt: clampXToLine(xPt, nearestLine),
      yPt: nearestLine.yTopPt + nearestLine.heightPt / 2,
      baseDir: documentDir,
    }).catch(() => null);
  }

  function handleMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    // Mousedown on a non-focusable target (the stage `<div>`/its SVG
    // children) has a *default* browser action that shifts/blurs focus,
    // firing after this handler returns — without preventing it, that
    // default action immediately undoes the explicit `.focus()` call below,
    // so the hidden textarea never actually keeps focus and no keyboard
    // event (typing, arrow keys) ever reaches it, even though this handler
    // itself runs fine (which is why click-to-position still worked).
    event.preventDefault();
    hiddenInputRef.current?.focus();
    // Set synchronously, not inside the `.then()` below — `offsetAtClient`
    // is async (an `invoke` round-trip, doubled when it falls back to the
    // blank-space snap), so a fast click's `mouseup` can fire and clear
    // this *before* that promise resolves; the resolution then set it back
    // to `true` afterward, leaving drag-mode stuck on even though the
    // button was already released — every following mouse movement (with
    // no button held) then extended a selection, which read as a bogus
    // "long press."
    draggingRef.current = true;
    offsetAtClient(event.clientX, event.clientY).then((offset) => {
      if (offset == null) return;
      preferredXPtRef.current = null;
      setAnchorOffset(offset);
      setCursorOffset(offset);
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

  // M21: text editing. `source` is the raw Typst source buffer — edited
  // directly here, never through ProseMirror (M15's finding: PM is, at
  // most, an on-demand structural transformer for tables/lists/figures, not
  // a persistent editing surface for plain text).
  function selectionRange(): [number, number] {
    return [Math.min(anchorOffset, cursorOffset), Math.max(anchorOffset, cursorOffset)];
  }

  // The one primitive every edit reduces to: replace `[start, end)` with
  // `insertText`, then collapse the cursor to just after it. Every other
  // handler below only has to compute the right range.
  function commitEdit(start: number, end: number, insertText: string) {
    const result = spliceSource(source, start, end, insertText);
    onChange(result.source);
    setCursorOffset(result.cursorOffset);
    setAnchorOffset(result.cursorOffset);
  }

  function handleInsert(text: string) {
    const [start, end] = selectionRange();
    commitEdit(start, end, text);
  }

  function handleDeleteBackward() {
    const [start, end] = selectionRange();
    if (start !== end) {
      commitEdit(start, end, "");
    } else {
      commitEdit(stepByteOffset(source, cursorOffset, "left"), cursorOffset, "");
    }
  }

  function handleDeleteForward() {
    const [start, end] = selectionRange();
    if (start !== end) {
      commitEdit(start, end, "");
    } else {
      commitEdit(cursorOffset, stepByteOffset(source, cursorOffset, "right"), "");
    }
  }

  // `input`/`compositionend`, not `keydown` — matches M18's validated
  // harness exactly, since IME composition only works correctly through the
  // browser's own composition machinery, not synthesized from individual
  // keydowns. The hidden `<textarea>`'s own value is cleared after every
  // commit (see both handlers below) so it never needs diffing — each event
  // already carries exactly the piece of text that changed.
  function handleHiddenInputChange(event: React.FormEvent<HTMLTextAreaElement>) {
    const native = event.nativeEvent as InputEvent;
    const el = event.currentTarget;
    // Not just `native.isComposing` — see `composingRef`'s own comment.
    if (native.isComposing || composingRef.current) return;

    if (native.inputType === "deleteContentBackward") {
      handleDeleteBackward();
    } else if (native.inputType === "deleteContentForward") {
      handleDeleteForward();
    } else if (native.inputType === "insertLineBreak") {
      // A *single* newline is a soft break in Typst source (just
      // whitespace — swallowed into the same paragraph, same as
      // Markdown), not a new paragraph. Inserting one `\n` per Enter press
      // faithfully matches what typing that raw text into the Typst
      // source view would do, but reads as "Enter does nothing" for a
      // WYSIWYG-style editing surface, where one Enter is expected to
      // start a visibly new paragraph immediately. A blank line (`\n\n`)
      // is what actually does that in Typst, so that's what Enter inserts
      // here instead — a deliberate WYSIWYG-affordance choice, not a
      // literal transcription of the keystroke.
      handleInsert("\n\n");
    } else if (native.data) {
      handleInsert(native.data);
    } else if (el.value) {
      // Fallback for a path that doesn't populate `data` (e.g. some paste
      // flows) — insert whatever ended up in the textarea's own value.
      handleInsert(el.value);
    }
    el.value = "";
  }

  function handleCompositionStart() {
    composingRef.current = true;
  }

  function handleCompositionEnd(event: React.CompositionEvent<HTMLTextAreaElement>) {
    composingRef.current = false;
    if (event.data) handleInsert(event.data);
    event.currentTarget.value = "";
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
        // The *sticky* column remembers the original, unclamped X (so
        // returning to a longer line later snaps back to it, standard
        // editor UX) — but the actual click must be clamped into the
        // target line's own extent, or aiming past a *shorter* line's end
        // gives `jump_from_click` nothing to resolve to, and the caret
        // appears frozen.
        const preferredXPt = preferredXPtRef.current ?? fromRect.xPt;
        preferredXPtRef.current = preferredXPt;
        const targetY = target.yTopPt + target.heightPt / 2;
        const offset = await invoke<number | null>("jump_from_click", {
          source,
          xPt: clampXToLine(preferredXPt, target),
          yPt: targetY,
          baseDir: documentDir,
        }).catch(() => null);
        if (offset != null) moveTo(offset, next.extend);
      }
    }
    drainVerticalMoveQueue();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Backspace/Delete on the hidden textarea never fire an `input` event at
    // all, since its value is always cleared back to "" right after every
    // commit (see `handleHiddenInputChange`/`handleCompositionEnd`) — there's
    // nothing there for the browser to delete *from*, so it doesn't dispatch
    // one. Handled directly here instead of waiting for an event that will
    // never come. Doesn't interfere with backspacing *during* IME
    // composition (which does need the native `deleteContentBackward`
    // `input` path below, since the textarea genuinely holds the in-progress
    // composition string then) — `event.key` reports as `"Process"`, not
    // `"Backspace"`, while composing (M18's own finding), so this check
    // naturally only matches the non-composing case.
    if (event.key === "Backspace") {
      event.preventDefault();
      handleDeleteBackward();
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      handleDeleteForward();
      return;
    }
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
    <div className="typst-live-view" ref={scrollContainerRef} onScroll={handleContainerScroll}>
      <p className="scope-note">
        Experimental (M20/M21): a real caret/selection and typing directly on the live Typst render — click to
        position, drag to select, arrow keys (with Shift to extend) to navigate, type to edit. IME composition
        commits correctly but shows no live preview yet (that's a follow-up — see M18). The document redraws on a
        short debounce after each edit, not instantly per keystroke.
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
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <textarea
          ref={hiddenInputRef}
          className="typst-live-hidden-input"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          onKeyDown={handleKeyDown}
          onInput={handleHiddenInputChange}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
        />
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
