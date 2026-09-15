// Pure undo/redo history for TypstLiveView.tsx's cross-block editing model
// (interaction-design.md §8; plan.md "跨块撤销/重做"). Decoupled from React
// state/DOM — same "pure logic module + unit tests" split blockSplit.ts/
// splitLayout.ts already use.
//
// Storage strategy is grounded in the CodeMirror `history()` extension
// already vendored in this repo (`@codemirror/commands`, used by
// SourceEditor.tsx — read directly from `node_modules/@codemirror/commands/
// dist/index.js`, not recalled from memory): most entries store a small,
// reversible `Delta` (mirrors `HistEvent` storing `tr.changes.invert(...)`)
// rather than a full document snapshot; only structural-command entries
// (no single contiguous byte-range diff — `runToolbarCommand`) fall back to
// a full snapshot. Coalescing a typing run requires both a time window AND
// edit-range adjacency (CodeMirror's own `newGroupDelay` + `isAdjacent`),
// not just the time window alone — see `deltasAdjacent`.
//
// No stack-size cap for v1: unlike CodeMirror, entries here are inert until
// actually popped (no per-keystroke remapping of every stored entry), so
// the main cost driving CodeMirror's own `minDepth` cap doesn't apply —
// only raw memory does, and delta storage keeps that small already. A
// byte-budget-based eviction is a known, deliberately deferred follow-up if
// an unusually long session ever makes this matter.

import { byteToUtf16Offset, utf16ToByteOffset } from "../util/offsets";

export type FocusSnapshot =
  | { kind: "combined"; cursorOffset: number; anchorOffset: number }
  | { kind: "block"; blockIdx: number };

// A reversible edit exactly as `spliceSource` (typstCursor.ts) already
// expresses one: `start` is a Typst byte offset (not a UTF-16 index, like
// every other byte-offset value in this codebase); `removed`/`inserted` are
// UTF-16 strings (like `source` itself) — byte lengths are computed at
// apply-time via `utf16ToByteOffset`, not stored separately.
export type Delta = { start: number; removed: string; inserted: string };

export type HistoryEntry =
  // The splice-based commit points (`commitFocusedDraft`, `switchFocusTo`,
  // `crossBlockBoundary`, `jumpToReference`, `resolveHandoffDrop`,
  // `commitEdit`). A coalesced typing run is still *one* entry — `deltas`
  // accumulates each keystroke's own Delta rather than merging them into
  // one wider Delta (merging correctly across an arbitrary mix of
  // inserts/deletes within one run is a real algorithm with real edge
  // cases; applying a *list* of exact, individually reversible deltas in
  // sequence has none of that risk).
  | { kind: "deltas"; deltas: Delta[]; focus: FocusSnapshot; timestampMs: number }
  // `runToolbarCommand`'s two call sites only — a structural transform's
  // old/new source aren't related by one contiguous byte-range replacement,
  // so a delta doesn't apply; stores the *previous* source as a full
  // fallback, since these are comparatively rare (not a per-keystroke path).
  | { kind: "snapshot"; source: string; focus: FocusSnapshot; timestampMs: number };

export type HistoryState = { undo: HistoryEntry[]; redo: HistoryEntry[] };

export const emptyHistory: HistoryState = { undo: [], redo: [] };

export const COALESCE_MS = 500;

function byteLength(text: string): number {
  return utf16ToByteOffset(text, text.length);
}

// The byte offset immediately after `delta`'s own edit, in whatever source
// it was applied to — where a cursor naturally ends up right after typing
// or deleting there.
function cursorAfterDelta(delta: Delta): number {
  return delta.start + byteLength(delta.inserted);
}

// Two deltas chain into the same coalesced run if the second one's edit
// touches the point where the first one left off — covers both directions
// (continuing to type forward, or continuing to backspace backward), not
// just "starts where the last one's insert ended". Mirrors CodeMirror's
// `isAdjacent` (`index.js:416-427`): a time window alone isn't enough, an
// edit somewhere unrelated within the window must not join.
export function deltasAdjacent(prev: Delta, next: Delta): boolean {
  const anchor = cursorAfterDelta(prev);
  return next.start <= anchor && next.start + byteLength(next.removed) >= anchor;
}

// Applies `delta` forward against the source it was captured from (i.e.
// replaces `delta.removed`, sitting at `delta.start`, with
// `delta.inserted`) — the same replacement `spliceSource` performs.
export function applyDeltaForward(source: string, delta: Delta): string {
  const utf16Start = byteToUtf16Offset(source, delta.start);
  const utf16End = utf16Start + delta.removed.length;
  return source.slice(0, utf16Start) + delta.inserted + source.slice(utf16End);
}

// Applies `delta`'s inverse against a source that already has `inserted`
// sitting at `delta.start` (i.e. replaces it back with `removed`).
export function applyDeltaInverse(source: string, delta: Delta): string {
  const utf16Start = byteToUtf16Offset(source, delta.start);
  const utf16End = utf16Start + delta.inserted.length;
  return source.slice(0, utf16Start) + delta.removed + source.slice(utf16End);
}

// Reconstructs the source from *before* `deltas` were applied, given the
// source they produce — undo direction. Deltas apply in reverse order
// (undoing the last keystroke of the run first), each against the result
// of undoing the one after it.
export function undoDeltas(resultSource: string, deltas: Delta[]): string {
  let s = resultSource;
  for (let i = deltas.length - 1; i >= 0; i--) s = applyDeltaInverse(s, deltas[i]);
  return s;
}

// Reconstructs the source `deltas` produce, given the source from before
// they were applied — redo direction, forward order.
export function redoDeltas(beforeSource: string, deltas: Delta[]): string {
  let s = beforeSource;
  for (const delta of deltas) s = applyDeltaForward(s, delta);
  return s;
}

// Records one committed change onto the undo stack (and clears redo — any
// new change invalidates it, matching every other editor's convention).
// `coalesce: true` (only `commitEdit`'s per-keystroke delta path) appends
// `change.delta` onto the *top* undo entry's own `deltas` array instead of
// pushing a new entry, but only if ALL of: the top entry is itself a
// same-run "deltas" entry; it was pushed within `COALESCE_MS` of `nowMs`;
// and `change.delta` is adjacent (`deltasAdjacent`) to that entry's own
// last delta. Otherwise (including every `coalesce: false` call, or either
// check failing) pushes a fresh entry. Pure — returns a new HistoryState.
export function recordChange(
  state: HistoryState,
  beforeFocus: FocusSnapshot,
  change: { kind: "delta"; delta: Delta } | { kind: "snapshot"; source: string },
  coalesce: boolean,
  nowMs: number,
): HistoryState {
  const top = state.undo[state.undo.length - 1];
  if (
    coalesce &&
    change.kind === "delta" &&
    top &&
    top.kind === "deltas" &&
    nowMs - top.timestampMs < COALESCE_MS &&
    deltasAdjacent(top.deltas[top.deltas.length - 1], change.delta)
  ) {
    const merged: HistoryEntry = {
      kind: "deltas",
      deltas: [...top.deltas, change.delta],
      focus: top.focus,
      timestampMs: nowMs,
    };
    return { undo: [...state.undo.slice(0, -1), merged], redo: [] };
  }
  const entry: HistoryEntry =
    change.kind === "delta"
      ? { kind: "deltas", deltas: [change.delta], focus: beforeFocus, timestampMs: nowMs }
      : { kind: "snapshot", source: change.source, focus: beforeFocus, timestampMs: nowMs };
  return { undo: [...state.undo, entry], redo: [] };
}

// Pops the top entry off `undo`/`redo` (if any). Returns null if empty.
// Does *not* touch the opposite stack — pushing the corresponding reverse
// entry is the caller's job (TypstLiveView.tsx's `undo()`/`redo()`), since
// it needs the live `source` this module deliberately doesn't hold.
export function popUndo(state: HistoryState): { state: HistoryState; entry: HistoryEntry } | null {
  const entry = state.undo[state.undo.length - 1];
  if (!entry) return null;
  return { state: { undo: state.undo.slice(0, -1), redo: state.redo }, entry };
}

export function popRedo(state: HistoryState): { state: HistoryState; entry: HistoryEntry } | null {
  const entry = state.redo[state.redo.length - 1];
  if (!entry) return null;
  return { state: { undo: state.undo, redo: state.redo.slice(0, -1) }, entry };
}

export function pushEntry(stack: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  return [...stack, entry];
}
