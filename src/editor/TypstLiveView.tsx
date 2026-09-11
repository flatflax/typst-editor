// Focus-reveals-source (interaction-design.md §6, plan.md Phase 4): the
// primary editing mechanism as of its real (non-spike) landing — validated
// in the Phase 4 spikes (phase4-product-validation.md) and ported from
// `FocusRevealSpike3.tsx` onto this component's already-working M20/M21/M22
// machinery, rather than rebuilt from scratch, since that machinery already
// correctly handles the "combined" state this narrows down to. A block
// (`blockSplit.ts`) whose cursor/selection is fully collapsed inside it
// becomes a real, native `<textarea>` (free undo/redo, IME, copy/paste) —
// `focusedBlock` state, `enterFocus`/`commitFocusedDraft`/`switchFocusTo`,
// split-mode rendering (`splitLayout.ts`) further down. `focusedBlock ===
// null` is the *narrower* state everything below this comment originally
// covered for the whole document — now only reached for a genuine
// cross-block selection, or before the first click:
//
// M20/M21 (plan.md): static cursor/selection/hit-testing, plus (M21) a real
// edit loop, directly on live Typst rendering — still exactly how a
// cross-block selection is drawn and edited (self-drawn caret/selection
// overlay, hidden-textarea-driven splice). The whole compiled document is
// always shown, full multi-page, with a caret/selection drawn from the same
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
// events, not `keydown`, so IME composition machinery works correctly) —
// now only reachable while editing/deleting an active cross-block
// selection, since a collapsed cursor always focuses a block instead (see
// `handleMouseUp`). No live composition overlay yet — a composing IME shows
// nothing on screen until `compositionend` commits it, unlike M18's own
// harness. Deferred as a known limitation, not solved here: it needs the
// same live-overlay technique M18 validated, wired to the real compiled
// document instead of a static sample. Moot for the common case now that a
// focused block gets IME natively for free.
//
// M22: a "pending" badge fills the settle window between a keystroke and
// the next real redraw — there is no second rendering engine to draw from
// (M15's whole finding), so this deliberately does *not* try to blend into
// the document's own text flow, which would need reimplementing Typst's
// line-wrapping. It's an obviously-distinct floating tooltip near the
// caret showing the current paragraph's raw source text, not a fake
// rendering of it — gone the instant the real compile lands. Split mode's
// per-block "Compiling…" placeholder (`renderOtherBlock`) is the
// block-focused equivalent of this same idea, not a separate mechanism.
//
// Deliberately not covered by this pass (phase4-product-validation.md's own
// scope note for this milestone): the M23 toolbar's integration with a
// focused block's draft (toolbar is hidden while a block is focused, not
// wired to it yet); Up/Down navigation across a block boundary; multi-page
// documents specifically in split mode (untested risk, not just undone);
// reference-chain navigation UI for `#set`/`#let`/labels.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Command } from "prosemirror-state";
import type { EditorDiagnostic } from "./SourceEditor";
import { clientPointFromPt, svgPointFromClient } from "../util/svgGeometry";
import { byteToUtf16Offset, utf16ToByteOffset } from "../util/offsets";
import {
  caretRectFromBoxes,
  clampXToLine,
  currentParagraphText,
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
import { runStructuralCommand, type StructuralEditResult } from "./structuralCommand";
import {
  addTableColumn,
  addTableRow,
  deleteTableColumn,
  deleteTableRow,
  insertTable2x2,
  liftList,
  setHeading,
  setParagraph,
  toggleBulletList,
  toggleCode,
  toggleEm,
  toggleLink,
  toggleOrderedList,
  toggleStrong,
} from "./wysiwygCommands";
import { blockAt, blockByteRanges } from "./blockSplit";
import {
  cropSvgVertically,
  fairShareBoundsFromInk,
  focusedLayoutPxFromInk,
  pageDimsFromSvg,
  parseViewBox,
  unionYRange,
  widenContentBounds,
  type BlockYRange,
  type ContentBoundsPt,
  type FocusedLayoutPx,
} from "./splitLayout";

// M23: the toolbar buttons ported from the WYSIWYG view's own toolbar
// (wysiwygCommands.ts) — the slash menu comes in a later slice of this
// milestone, once block-type/mark/table toggles are confirmed working end
// to end.
//
// Each item names a `run` step chain rather than a single PM `Command`: most
// buttons are exactly one command, but "P" needs two run in sequence
// (`liftList` then `setParagraph`) to actually escape a list — the original
// WYSIWYG editor only ever exposed that lift via Shift-Tab, never a button,
// so `setParagraph` alone (a no-op on a list item, which is already type
// `paragraph`) was never *reachable* as a "stuck in a list" toolbar bug
// there. Live cursor's toolbar is button-only (no keymap yet), so it has to
// stand on its own.
//
// Known gap, not fixed here: `toggleStrong`/`toggleEm`/`toggleCode` are a
// no-op on a collapsed cursor with nothing selected — the same as the
// original WYSIWYG toolbar *looks* like on the surface, but there PM's
// `storedMarks` would carry the toggle onto the *next* typed character; here
// there's no persistent PM state for storedMarks to live in between one
// throwaway transform and the next real keystroke (which goes through
// `commitEdit`'s raw splice, not PM at all). Select text first for a mark
// toggle to do anything.
const TOOLBAR_ITEMS: { label: string; steps: Command[] }[] = [
  { label: "P", steps: [liftList, setParagraph] },
  { label: "H1", steps: [setHeading(1)] },
  { label: "H2", steps: [setHeading(2)] },
  { label: "H3", steps: [setHeading(3)] },
  { label: "• List", steps: [toggleBulletList] },
  { label: "1. List", steps: [toggleOrderedList] },
  { label: "B", steps: [toggleStrong] },
  { label: "I", steps: [toggleEm] },
  { label: "Code", steps: [toggleCode] },
  { label: "Link", steps: [toggleLink] },
  { label: "Table", steps: [insertTable2x2] },
  { label: "+Row", steps: [addTableRow] },
  { label: "+Col", steps: [addTableColumn] },
  { label: "-Row", steps: [deleteTableRow] },
  { label: "-Col", steps: [deleteTableColumn] },
];

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

function sliceByBytes(source: string, startByte: number, endByte: number): string {
  return source.slice(byteToUtf16Offset(source, startByte), byteToUtf16Offset(source, endByte));
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
  // `handleMouseDown`'s own offset resolution (setting anchorOffset) is
  // *also* an async invoke round-trip, same as a drag point's — a fast drag
  // fires mousemove (and its own offsetAtClient call) before mousedown's
  // promise has resolved, so `resolveNextDragPoint` could set cursorOffset
  // from a *later* mouse position while anchorOffset is still whatever it
  // was from the previous interaction, corrupting the selection range they
  // end up forming together. Confirmed live: dragging over "matching"
  // yielded a selection landing on "hing poi" instead, on the very first
  // interaction after launch — not something a stale/prior anchorOffset
  // value would produce unless this exact race occurred. Every drag point
  // now waits for this to resolve first, guaranteeing anchorOffset always
  // lands before any cursorOffset update from dragging can.
  const mouseDownResolvedRef = useRef<Promise<unknown>>(Promise.resolve());
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
  // whatever `cursorOffset` was as of this closure's last render. Also
  // updated *synchronously* inside `handleMouseDown`/`resolveNextDragPoint`'s
  // own async resolution below (not just from this per-render sync line) —
  // `handleMouseUp` needs to read the *just-resolved* value the instant the
  // button is released, which a value that only updates on the next render
  // can't guarantee.
  const cursorOffsetRef = useRef(cursorOffset);
  cursorOffsetRef.current = cursorOffset;
  const anchorOffsetRef = useRef(anchorOffset);
  anchorOffsetRef.current = anchorOffset;

  // M22: whether the currently-typed `source` is reflected by the
  // currently-*displayed* `svg` yet. Two explicit effects, not one derived
  // from a ref: mutating a ref alone doesn't trigger a re-render, so
  // clearing "pending" that way would only take visible effect once
  // *something else* (e.g. the geometry-refetch effect below) happened to
  // also re-render around the same time — true in practice since both
  // debounces share a timing constant, but incidental, not guaranteed.
  // Explicit `setIsPending` calls make hiding the badge not depend on that.
  const [isPending, setIsPending] = useState(false);
  useEffect(() => {
    setIsPending(true);
  }, [source]);
  useEffect(() => {
    setIsPending(false);
  }, [svg]);

  // Block model (interaction-design.md §6, validated in Phase 4's spikes —
  // phase4-product-validation.md): when the cursor/selection falls entirely
  // within one block, that block becomes a real, native `<textarea>`
  // (free undo/redo, IME, copy/paste); every other block stays fully
  // rendered. `focusedBlock === null` is the narrower "combined" state this
  // now is — a genuine cross-block selection (the self-drawn overlay below
  // still owns that), or nothing at all yet — not "free typing happens
  // here" the way it used to; a plain click always resolves into some
  // block's focus (see `handleMouseUp`), matching the design doc's own
  // wording rather than requiring a second, separate action to "enter" a
  // block.
  const [focusedBlock, setFocusedBlock] = useState<number | null>(null);
  // Bumped on every (re-)focus (`enterFocus`/`switchFocusTo`/a toolbar
  // command's own re-focus below), folded into the focused textarea's React
  // `key` — without it, re-focusing the *same* block index (e.g. a toolbar
  // command that changes a paragraph's content but not which block it is)
  // wouldn't remount the textarea, so its uncontrolled `defaultValue` would
  // never pick up the new draft text.
  const [focusGeneration, setFocusGeneration] = useState(0);
  const [otherBlocksYRanges, setOtherBlocksYRanges] = useState<Map<number, BlockYRange>>(new Map());
  const [focusedBlockLayoutPx, setFocusedBlockLayoutPx] = useState<FocusedLayoutPx | null>(null);
  const lockedWidthPxRef = useRef<number | null>(null);
  const draftRef = useRef("");
  const focusedTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const nativeDragAnchorUtf16Ref = useRef<number | null>(null);
  const nativeDraggingRef = useRef(false);
  const draggedOutsideRef = useRef(false);
  const lastMouseClientRef = useRef<{ clientX: number; clientY: number } | null>(null);
  // True from the instant a focused block's blur/handoff has already
  // committed its draft into `source` (`commitFocusedDraft`/the native-drag
  // handoff below) until the next time a block is (re-)focused — guards
  // against the native `blur` event a DOM-unmount fires (when React swaps
  // the textarea back out for rendered content) re-triggering the same
  // commit a second time.
  const handedOffRef = useRef(false);

  // Incremental replacement for the original "fetch every block's geometry
  // in one `block_geometry` call" approach (still what the throwaway spike
  // this was ported from does). `geometry_for_range` (src-tauri) walks the
  // *entire* document's glyphs for *each* requested range regardless of how
  // narrow that range is — one call covering every block in a real
  // multi-page document costs O(block count × total glyphs), confirmed live
  // (phase4-product-validation.md, 2026-09-11) to make every focus-entry/
  // switch on a real multi-page document slow, with every other block stuck
  // on its "Compiling…" placeholder for however long that took. Only the
  // focused block + its immediate neighbors are fetched synchronously (a
  // small, bounded request regardless of document size) before flipping
  // into split mode — same reasoning as before for *why* this needs to
  // happen before any state change (a reactive effect keyed on
  // `focusedBlock` produced a visible stutter, entering split mode with no
  // margins for one frame). Every other block is backfilled lazily, only
  // once it actually scrolls into view — the `IntersectionObserver` wiring
  // below `renderOtherBlock`.
  //
  // `blockInkRangesRef` caches each block's own *raw* ink range (not
  // fair-share — every block's fair share only ever needs its own ink plus
  // its two immediate neighbors', per `fairShareBoundsFromInk`, so there's
  // no cascading whole-document dependency to worry about), valid only for
  // `blockInkSourceRef.current` — reset whenever `source` no longer matches
  // (any commit invalidates every block's position, since blocks after the
  // edited one may have reflowed).
  const blockInkRangesRef = useRef<Map<number, BlockYRange>>(new Map());
  const blockInkSourceRef = useRef<string | null>(null);
  const contentBoundsRef = useRef<ContentBoundsPt | null>(null);
  const pendingBlockFetchRef = useRef<Set<number>>(new Set());

  async function ensureBlockGeometry(
    effectiveSource: string,
    focusedIdx: number | null,
    indices: number[],
  ): Promise<FocusedLayoutPx | null> {
    if (blockInkSourceRef.current !== effectiveSource) {
      blockInkRangesRef.current = new Map();
      contentBoundsRef.current = null;
      pendingBlockFetchRef.current = new Set();
      blockInkSourceRef.current = effectiveSource;
      // Clears stale (pre-edit) crops rather than leaving them displayed —
      // React batches this with the fresh subset this same call goes on to
      // set below (each queued update to the same state is applied in
      // order), so the blocks this call is actually responsible for don't
      // flash empty first.
      setOtherBlocksYRanges(new Map());
    }

    const totalBlocks = blockByteRanges(effectiveSource).length;
    const validIndices = indices.filter((i) => i >= 0 && i < totalBlocks);
    const toFetch = validIndices.filter(
      (i) => !blockInkRangesRef.current.has(i) && !pendingBlockFetchRef.current.has(i),
    );

    if (toFetch.length > 0) {
      for (const i of toFetch) pendingBlockFetchRef.current.add(i);
      const allRanges = blockByteRanges(effectiveSource);
      let results: RawRangeBox[][] | null = null;
      try {
        results = await invoke<RawRangeBox[][]>("block_geometry", {
          source: effectiveSource,
          baseDir: documentDir,
          ranges: toFetch.map((i) => allRanges[i]),
        });
      } catch {
        results = null;
      }
      for (const i of toFetch) pendingBlockFetchRef.current.delete(i);
      // The cache was invalidated (a newer `source`) while this was in
      // flight — these results are for a document that no longer exists,
      // discard rather than merge them into the new cache.
      if (blockInkSourceRef.current !== effectiveSource) return null;
      if (results) {
        toFetch.forEach((i, n) => {
          const boxes = results![n];
          const ink = unionYRange(selectionRectsFromBoxes(pageOffsetsPt, boxes));
          if (ink) blockInkRangesRef.current.set(i, ink);
          contentBoundsRef.current = widenContentBounds(contentBoundsRef.current, boxes);
        });
      }
    }

    const pageDims = pageDimsFromSvg(svg);
    if (pageDims == null) return null;

    const otherUpdates = new Map<number, BlockYRange>();
    for (const i of validIndices) {
      if (i === focusedIdx) continue;
      const bounds = fairShareBoundsFromInk(i, blockInkRangesRef.current, totalBlocks, pageDims.heightPt);
      if (bounds) otherUpdates.set(i, bounds);
    }
    if (otherUpdates.size > 0) {
      setOtherBlocksYRanges((prev) => {
        const next = new Map(prev);
        for (const [i, r] of otherUpdates) next.set(i, r);
        return next;
      });
    }

    if (focusedIdx == null) return null;
    const focusedFairShare = fairShareBoundsFromInk(focusedIdx, blockInkRangesRef.current, totalBlocks, pageDims.heightPt);
    const focusedOwnInk = blockInkRangesRef.current.get(focusedIdx);
    if (!focusedFairShare || !focusedOwnInk || !contentBoundsRef.current) return null;
    return focusedLayoutPxFromInk(focusedFairShare, focusedOwnInk, contentBoundsRef.current, pageDims, lockedWidthPxRef.current);
  }

  // Lazily backfills every non-focused block's own ink range the instant it
  // actually scrolls into view, instead of proactively fetching the whole
  // document up front (see `ensureBlockGeometry`'s own comment). One
  // long-lived observer for the component's lifetime; each
  // `renderOtherBlock` div registers/unregisters itself via its `ref`
  // callback as it mounts/unmounts (naturally happens whenever the block
  // count changes after a commit).
  const blockObserverRef = useRef<IntersectionObserver | null>(null);
  const observedBlockElementsRef = useRef<Map<number, Element>>(new Map());
  const elementToBlockIndexRef = useRef<WeakMap<Element, number>>(new WeakMap());
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const focusedBlockRef = useRef(focusedBlock);
  focusedBlockRef.current = focusedBlock;

  function ensureBlockObserver(): IntersectionObserver {
    if (!blockObserverRef.current) {
      blockObserverRef.current = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const idx = elementToBlockIndexRef.current.get(entry.target);
            if (idx == null) continue;
            if (blockInkSourceRef.current === sourceRef.current && blockInkRangesRef.current.has(idx)) continue;
            void ensureBlockGeometry(sourceRef.current, focusedBlockRef.current, [idx - 1, idx, idx + 1]);
          }
        },
        { root: scrollContainerRef.current, rootMargin: "200px" },
      );
    }
    return blockObserverRef.current;
  }

  function registerBlockElement(idx: number, el: HTMLDivElement | null) {
    const observer = ensureBlockObserver();
    const prevEl = observedBlockElementsRef.current.get(idx);
    if (prevEl && prevEl !== el) {
      observer.unobserve(prevEl);
      observedBlockElementsRef.current.delete(idx);
    }
    if (el) {
      elementToBlockIndexRef.current.set(el, idx);
      observedBlockElementsRef.current.set(idx, el);
      observer.observe(el);
    }
  }

  // Enters focus for block `idx` — the one place a block *starts* being
  // shown as a native textarea (a plain click, or landing back on a single
  // block after a cross-block drag collapses to one — see `handleMouseUp`).
  async function enterFocus(idx: number, widthSourceSvg: SVGSVGElement | null) {
    const ranges = blockByteRanges(source);
    lockedWidthPxRef.current = widthSourceSvg?.getBoundingClientRect().width ?? null;
    const focusedLayoutPx = await ensureBlockGeometry(source, idx, [idx - 1, idx, idx + 1]);
    draftRef.current = sliceByBytes(source, ranges[idx][0], ranges[idx][1]);
    handedOffRef.current = false;
    setFocusedBlockLayoutPx(focusedLayoutPx);
    setSelectionRects([]);
    setFocusGeneration((g) => g + 1);
    setFocusedBlock(idx);
  }

  // Native blur — the focused block's draft (which may now contain its own
  // blank line(s)) is reparsed only at this point ("lazy" split, the
  // winning half of Spike 3's lazy-vs-eager comparison —
  // phase4-product-validation.md). `blockByteRanges` on the freshly
  // committed source naturally reports however many blocks that produces.
  function commitFocusedDraft() {
    if (handedOffRef.current || focusedBlock === null) return;
    const ranges = blockByteRanges(source);
    const [start, end] = ranges[focusedBlock];
    const result = spliceSource(source, start, end, draftRef.current);
    onChange(result.source);
    setFocusedBlock(null);
  }

  // Clicking a sibling block directly while another is focused. Committing
  // the currently-focused block first can change *how many* blocks exist
  // before this one — relocates the target by byte position (captured
  // before the commit, shifted by the focused block's own length delta)
  // rather than trusting its old array index, which the commit can shift
  // out from under it.
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
    const focusedLayoutPx = await ensureBlockGeometry(effectiveSource, newIdx, [newIdx - 1, newIdx, newIdx + 1]);
    draftRef.current = sliceByBytes(effectiveSource, newRanges[newIdx][0], newRanges[newIdx][1]);
    handedOffRef.current = false;
    setFocusedBlockLayoutPx(focusedLayoutPx);
    if (effectiveSource !== source) onChange(effectiveSource);
    setFocusGeneration((g) => g + 1);
    setFocusedBlock(newIdx);
  }

  function autosizeTextarea(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  // Where the caret should land the next time a block is (re-)focused, in
  // UTF-16 units within *that block's own* draft text — `null` means "the
  // end" (every ordinary click-to-focus path's existing behavior). Only
  // `runToolbarCommand` sets this today, so a structural command that lands
  // its result mid-paragraph (not just "append a heading at the end") still
  // puts the caret where the edit actually happened, not at the tail.
  const pendingCursorUtf16Ref = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (focusedBlock === null) return;
    const el = focusedTextareaRef.current;
    if (!el) return;
    el.focus();
    const pos = pendingCursorUtf16Ref.current ?? el.value.length;
    pendingCursorUtf16Ref.current = null;
    el.setSelectionRange(pos, pos);
    autosizeTextarea(el);
  }, [focusedBlock]);

  // Resolves where a drag that continued out of a focused block's textarea
  // and was released in combined-mode territory should land — once every
  // sign that the resulting commit has actually landed agrees. Reuses the
  // *existing* selection state/geometry-fetch effect above (setting
  // `anchorOffset`/`cursorOffset` here is enough to make it draw the
  // resulting cross-block selection) rather than a second, parallel one —
  // unlike the throwaway spike this was ported from, which had no such
  // effect of its own to reuse.
  async function resolveHandoffDrop(pending: { anchorByte: number; clientX: number; clientY: number }) {
    const base = baseSvgEl();
    if (!base) return;
    const { xPt, yPt } = svgPointFromClient(base, pending.clientX, pending.clientY);
    const offset = await invoke<number | null>("jump_from_click", { source, xPt, yPt, baseDir: documentDir }).catch(
      () => null,
    );
    if (offset == null) return;
    anchorOffsetRef.current = pending.anchorByte;
    cursorOffsetRef.current = offset;
    setAnchorOffset(pending.anchorByte);
    setCursorOffset(offset);
    // The focused block's own textarea had DOM focus right up until this
    // handoff unmounted it; nothing else claims it once combined mode
    // renders instead, so it silently reverts to nothing (`document.body`).
    // Found live (2026-09-11): without this, every keyboard interaction the
    // resulting cross-block selection is supposed to support — arrow-key
    // collapse, typing/Backspace to replace or delete it — silently went
    // nowhere, since `handleKeyDown` is wired to this element specifically.
    hiddenInputRef.current?.focus();
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
  // mode is decided once, at the gesture's end, not switched back and forth
  // mid-gesture). Found live (phase4-product-validation.md, 2026-09-10):
  // live-updating requires converting the *same* screen position through
  // two different coordinate systems in quick succession — the native
  // textarea's own font/line-height, and Typst's real SVG layout for the
  // identical text, which are never pixel-identical — so a drag that
  // visually looked like it was still inside the next block's text could
  // numerically already be past the last real glyph, in blank page space,
  // where `jump_from_click` legitimately (and permanently, for the rest of
  // that gesture) finds no target. Resolving only once, at mouseup, against
  // the mouse's one final position and one fresh render, sidesteps the
  // whole class of mid-drag coordinate drift.
  useEffect(() => {
    if (focusedBlock === null) return;
    const thisBlock = focusedBlock;
    function onWindowMouseMove(event: MouseEvent) {
      if (!nativeDraggingRef.current || handedOffRef.current) return;
      lastMouseClientRef.current = { clientX: event.clientX, clientY: event.clientY };
      const el = focusedTextareaRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const inside =
        event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
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
      const result = spliceSource(source, blockStart, blockEnd, draftRef.current);
      const anchorByte =
        blockStart + utf16ToByteOffset(draftRef.current, nativeDragAnchorUtf16Ref.current ?? draftRef.current.length);

      setFocusedBlock(null);
      onChange(result.source);
      // Always deferred to the effect above — even when the committed
      // source is unchanged (nothing typed, just a plain drag) this still
      // needs at least one render for `focusedBlock` to actually reach the
      // DOM as null; that effect's other two conditions are already
      // trivially satisfied in that case, so it resolves on the very next
      // render.
      pendingHandoffResolutionRef.current = {
        anchorByte,
        clientX: dropPoint.clientX,
        clientY: dropPoint.clientY,
        expectedSource: result.source,
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

  // M23 fix: while `isPending` (a real recompile is in flight, M22), the
  // still-*displayed* SVG was rendered from an *older* source than the one
  // `jump_from_click`/`block_geometry` would now resolve a pixel position
  // against (both always query the current `source`, invoked fresh — see
  // those two call sites below). Confirmed live: a click/drag made in that
  // window can land on visibly different text than what's under the
  // pointer, because the layout has already shifted underneath the still-
  // stale render. Refusing to resolve anything until the render catches up
  // trades a brief moment of "click does nothing" for never silently
  // selecting/positioning against the wrong text.
  async function offsetAtClient(clientX: number, clientY: number): Promise<number | null> {
    if (isPending) return null;
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
    mouseDownResolvedRef.current = offsetAtClient(event.clientX, event.clientY).then((offset) => {
      if (offset == null) return;
      preferredXPtRef.current = null;
      anchorOffsetRef.current = offset;
      cursorOffsetRef.current = offset;
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
    // Wait for mousedown's own anchor-setting resolution first — see
    // `mouseDownResolvedRef`'s own comment above.
    mouseDownResolvedRef.current
      .then(() => offsetAtClient(point.clientX, point.clientY))
      .then((offset) => {
        if (offset != null) {
          cursorOffsetRef.current = offset;
          setCursorOffset(offset);
        }
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

  // A plain click (no movement — anchor and cursor resolved to the same
  // offset) always lands inside exactly one block; per the design doc's own
  // wording (§6) that's enough to focus it, not just position a collapsed
  // caret there. A real drag whose two ends land in *different* blocks
  // stays exactly as before — a cross-block selection on the self-drawn
  // overlay, `focusedBlock` untouched.
  function handleMouseUp() {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const anchor = anchorOffsetRef.current;
    const cursor = cursorOffsetRef.current;
    if (anchor === cursor) {
      const idx = blockAt(blockByteRanges(source), anchor);
      if (idx != null) void enterFocus(idx, baseSvgEl());
    }
  }

  // Collapsing (not extending) a cross-block selection via the keyboard —
  // Left/Right always collapse, Up/Down collapse without Shift — used to
  // just leave a self-drawn, collapsed caret sitting in combined mode.
  // Found live (2026-09-11): that's the one path left where a collapsed
  // position doesn't immediately focus its block, unlike every mouse-driven
  // path (`handleMouseUp`) — inconsistent with the design's own rule that a
  // collapsed cursor/selection is *always* a focused block, not a separate
  // "combined mode with nothing selected" state. `pendingCursorUtf16Ref`
  // (see the toolbar-command comment above it) lands the caret at the exact
  // collapsed position instead of defaulting to the block's end.
  function moveTo(offset: number, extendSelection: boolean) {
    if (!extendSelection) {
      const ranges = blockByteRanges(source);
      const idx = blockAt(ranges, offset);
      if (idx != null) {
        const blockText = sliceByBytes(source, ranges[idx][0], ranges[idx][1]);
        pendingCursorUtf16Ref.current = byteToUtf16Offset(blockText, offset - ranges[idx][0]);
        void enterFocus(idx, baseSvgEl());
        return;
      }
    }
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

  // M23: a structural edit (toggle heading/list, and — later slices — marks/
  // tables) runs a *whole-document* parse -> PM command -> serialize round
  // trip (structuralCommand.ts), unlike `commitEdit`'s direct byte splice
  // above. `null` means the command didn't apply (e.g. toggleBulletList
  // already inside a bullet list, wysiwygCommands.ts's own no-op) — nothing
  // to do, not an error, so the source/cursor are simply left alone.
  //
  // `steps` runs in sequence, each against the *previous* step's result —
  // needed for "P" (`liftList` then `setParagraph`, see TOOLBAR_ITEMS) since
  // there's no live PM state here to compose multiple commands into one
  // transaction the way `chainCommands` would. A step that doesn't apply
  // (returns null) just leaves the source/cursor as the previous step left
  // them, rather than aborting the whole chain — e.g. `liftList` no-ops
  // outside a list, so "P" still falls through to plain `setParagraph`.
  //
  // While a block is focused, this still runs against the *whole* document
  // (a structural transform needs surrounding context — list nesting, table
  // structure — that a single block's text can't answer on its own), but
  // the visible result lands back *inside the same textarea* rather than
  // bouncing out to combined mode: the draft is committed first, the
  // command runs against that fresh source, and whichever block the
  // result's cursor now falls in is (re-)focused with the new content
  // already showing — confirmed live that this reads far better than a
  // jarring "exit focus, apply, re-enter" round trip would have.
  async function runToolbarCommand(steps: Command[]) {
    const wasFocused = focusedBlock;
    let effectiveSource = source;
    let cursorForCommand = cursorOffset;
    let anchorForCommand = anchorOffset;

    if (wasFocused !== null) {
      const ranges = blockByteRanges(source);
      const [start] = ranges[wasFocused];
      const el = focusedTextareaRef.current;
      const selStartUtf16 = el?.selectionStart ?? draftRef.current.length;
      const selEndUtf16 = el?.selectionEnd ?? draftRef.current.length;
      const spliced = spliceSource(source, ranges[wasFocused][0], ranges[wasFocused][1], draftRef.current);
      effectiveSource = spliced.source;
      anchorForCommand = start + utf16ToByteOffset(draftRef.current, Math.min(selStartUtf16, selEndUtf16));
      cursorForCommand = start + utf16ToByteOffset(draftRef.current, Math.max(selStartUtf16, selEndUtf16));
    }

    let current: StructuralEditResult = { source: effectiveSource, cursorOffset: cursorForCommand, anchorOffset: anchorForCommand };
    let ranAny = false;
    for (const step of steps) {
      const result = await runStructuralCommand(current.source, current.cursorOffset, current.anchorOffset, step);
      if (result) {
        current = result;
        ranAny = true;
      }
    }
    if (!ranAny) return;

    if (wasFocused !== null) {
      // Suppresses the stale `onBlur` the *old*-keyed textarea fires as
      // React unmounts it below (see `handedOffRef`'s own comment) — the
      // draft it would try to commit is about to be replaced anyway.
      handedOffRef.current = true;
      const newRanges = blockByteRanges(current.source);
      const newIdx = blockAt(newRanges, current.cursorOffset) ?? Math.min(wasFocused, newRanges.length - 1);
      draftRef.current = sliceByBytes(current.source, newRanges[newIdx][0], newRanges[newIdx][1]);
      pendingCursorUtf16Ref.current = byteToUtf16Offset(draftRef.current, current.cursorOffset - newRanges[newIdx][0]);
      const focusedLayoutPx = await ensureBlockGeometry(current.source, newIdx, [newIdx - 1, newIdx, newIdx + 1]);
      onChange(current.source);
      setFocusedBlockLayoutPx(focusedLayoutPx);
      setFocusGeneration((g) => g + 1);
      setFocusedBlock(newIdx);
    } else {
      onChange(current.source);
      setCursorOffset(current.cursorOffset);
      setAnchorOffset(current.anchorOffset);
    }
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

  // M22: the pending badge's position and text — `null` when there's
  // nothing to show (not pending, or no caret geometry yet to anchor to).
  // Computed inline during render, same as `viewBox` above — a plain read
  // (`getBoundingClientRect()`), not a mutation, so safe here the same way.
  const pendingBadge = (() => {
    if (!isPending || !caretRect) return null;
    const base = baseSvgEl();
    if (!base) return null;
    const { clientX, clientY } = clientPointFromPt(base, caretRect.xPt, caretRect.yTopPt);
    return { clientX, clientY, text: currentParagraphText(source, cursorOffset) };
  })();

  function renderFocusedTextarea(idx: number) {
    return (
      <textarea
        key={`${idx}-${focusGeneration}`}
        ref={focusedTextareaRef}
        className="typst-live-block-textarea"
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
          autosizeTextarea(event.currentTarget);
        }}
        onBlur={commitFocusedDraft}
        onKeyDown={(event) => {
          if (event.key === "Escape") event.currentTarget.blur();
        }}
      />
    );
  }

  function renderOtherBlock(idx: number) {
    const yRange = otherBlocksYRanges.get(idx);
    // NOT cropped while `isPending` — `svg` is still the *previous* commit's
    // pixels at that point, and `yRange` (fetched fresh against the current
    // source) would cut the wrong band out of them.
    const cropped = !isPending && svg && yRange ? cropSvgVertically(svg, yRange.yTopPt, yRange.heightPt) : null;
    return (
      <div
        key={idx}
        ref={(el) => registerBlockElement(idx, el)}
        className="typst-live-block-rendered"
        tabIndex={0}
        onClick={(event) => void switchFocusTo(idx, event)}
        aria-label="Focus to edit source"
      >
        {cropped ? (
          <div className="typst-live-block-rendered-svg" dangerouslySetInnerHTML={{ __html: cropped }} />
        ) : (
          <p className="typst-live-block-placeholder">Compiling…</p>
        )}
      </div>
    );
  }

  return (
    <div className="typst-live-view" ref={scrollContainerRef} onScroll={handleContainerScroll}>
      <p className="scope-note">
        Focus-reveals-source (interaction-design.md §6): click a paragraph to edit its real source in a native
        textarea (free undo/redo, IME, copy/paste); every other paragraph stays fully rendered. Drag across a
        paragraph boundary for a cross-block selection instead. Structural editing (toolbar) and Up/Down navigation
        across a block boundary are still being integrated with this — see phase4-product-validation.md.
      </p>
      {diagnostics.map((d, i) => (
        <p key={i} className={`diagnostic diagnostic-${d.severity}`}>
          {d.severity}
          {d.line != null ? ` at ${d.line}:${d.column}` : ""}: {d.message}
        </p>
      ))}
      {/* Shown regardless of `focusedBlock` — `runToolbarCommand` now handles
          both cases (commit-and-stay-focused vs. the original combined-mode
          path) itself. */}
      <div className="typst-live-toolbar">
        {TOOLBAR_ITEMS.map((item) => (
          <button
            key={item.label}
            type="button"
            // Clicking a button naturally steals DOM focus from whichever
            // textarea currently has it (the hidden one, or a focused
            // block's own); without this, the *next* keystroke after using
            // the toolbar would land nowhere (same class of bug as M21's
            // mousedown-focus fix on the stage itself).
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void runToolbarCommand(item.steps)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {focusedBlock === null ? (
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
      ) : (
        blockByteRanges(source).map((_, i) => (i === focusedBlock ? renderFocusedTextarea(i) : renderOtherBlock(i)))
      )}
      {pendingBadge && (
        <div
          className="typst-live-pending-badge"
          style={{ left: pendingBadge.clientX, top: pendingBadge.clientY }}
        >
          {pendingBadge.text}
        </div>
      )}
    </div>
  );
};

export default TypstLiveView;
