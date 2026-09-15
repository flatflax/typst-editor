import { describe, expect, it } from "vitest";
import {
  applyDeltaForward,
  applyDeltaInverse,
  COALESCE_MS,
  deltasAdjacent,
  emptyHistory,
  popRedo,
  popUndo,
  recordChange,
  redoDeltas,
  undoDeltas,
  type Delta,
  type HistoryEntry,
} from "./editHistory";

const BLOCK0: { kind: "block"; blockIdx: number } = { kind: "block", blockIdx: 0 };

function insertDelta(start: number, inserted: string): Delta {
  return { start, removed: "", inserted };
}

function deleteDelta(start: number, removed: string): Delta {
  return { start, removed, inserted: "" };
}

describe("applyDeltaForward / applyDeltaInverse", () => {
  it("round-trips a plain-ASCII insert", () => {
    const before = "hello world";
    const delta = insertDelta(5, ",");
    const after = applyDeltaForward(before, delta);
    expect(after).toBe("hello, world");
    expect(applyDeltaInverse(after, delta)).toBe(before);
  });

  it("round-trips across a multi-byte (CJK) prefix", () => {
    // "你好" is 2 UTF-16 units but 6 UTF-8 bytes — start=6 lands right after
    // it in byte terms, exercising the byte<->UTF-16 conversion this delta
    // model depends on (typstCursor.ts's own `spliceSource` does the same).
    const before = "你好world";
    const delta = insertDelta(6, "!");
    const after = applyDeltaForward(before, delta);
    expect(after).toBe("你好!world");
    expect(applyDeltaInverse(after, delta)).toBe(before);
  });

  it("round-trips a delete", () => {
    const before = "hello world";
    const delta = deleteDelta(5, " ");
    const after = applyDeltaForward(before, delta);
    expect(after).toBe("helloworld");
    expect(applyDeltaInverse(after, delta)).toBe(before);
  });
});

describe("undoDeltas / redoDeltas", () => {
  it("reconstructs the pre-edit source from a chain of typed deltas, and back", () => {
    const original = "ab";
    // Simulates typing "c" then "d" at the end: "ab" -> "abc" -> "abcd".
    const deltas: Delta[] = [insertDelta(2, "c"), insertDelta(3, "d")];
    const typed = redoDeltas(original, deltas);
    expect(typed).toBe("abcd");
    expect(undoDeltas(typed, deltas)).toBe(original);
  });

  it("reconstructs correctly for a chain of backspaces", () => {
    const original = "abc";
    // Backspacing twice from the end: "abc" -> "ab" -> "a".
    const deltas: Delta[] = [deleteDelta(2, "c"), deleteDelta(1, "b")];
    const deleted = redoDeltas(original, deltas);
    expect(deleted).toBe("a");
    expect(undoDeltas(deleted, deltas)).toBe(original);
  });
});

describe("deltasAdjacent", () => {
  it("treats continued forward typing as adjacent", () => {
    const first = insertDelta(2, "c");
    const second = insertDelta(3, "d");
    expect(deltasAdjacent(first, second)).toBe(true);
  });

  it("treats a chain of backspaces as adjacent, not just the first one", () => {
    // Regression case: a naive "next.start must be >= prev.start" check
    // (the plan's own first-pass wording) breaks for the *second* backspace
    // in a chain, since each subsequent backspace's start is strictly
    // *before* the previous one's. The symmetric "touches prev's own
    // end-of-edit point" check must still treat these as one run.
    const removeC = deleteDelta(2, "c"); // "abc" -> "ab", cursor after: 2
    const removeB = deleteDelta(1, "b"); // "ab" -> "a"
    expect(deltasAdjacent(removeC, removeB)).toBe(true);
  });

  it("rejects an edit unrelated to where the previous one left off", () => {
    const typeHere = insertDelta(2, "x");
    const typeElsewhere = insertDelta(50, "y");
    expect(deltasAdjacent(typeHere, typeElsewhere)).toBe(false);
  });
});

describe("recordChange", () => {
  it("coalesces adjacent deltas within the time window into one entry", () => {
    let state = emptyHistory;
    state = recordChange(state, BLOCK0, { kind: "delta", delta: insertDelta(0, "a") }, true, 1000);
    state = recordChange(state, BLOCK0, { kind: "delta", delta: insertDelta(1, "b") }, true, 1100);
    state = recordChange(state, BLOCK0, { kind: "delta", delta: insertDelta(2, "c") }, true, 1200);
    expect(state.undo).toHaveLength(1);
    const entry = state.undo[0] as HistoryEntry & { kind: "deltas" };
    expect(entry.kind).toBe("deltas");
    expect(entry.deltas).toHaveLength(3);
    expect(entry.focus).toEqual(BLOCK0);
  });

  it("breaks the run once the time window elapses", () => {
    let state = emptyHistory;
    state = recordChange(state, BLOCK0, { kind: "delta", delta: insertDelta(0, "a") }, true, 1000);
    state = recordChange(state, BLOCK0, { kind: "delta", delta: insertDelta(1, "b") }, true, 1000 + COALESCE_MS);
    expect(state.undo).toHaveLength(2);
  });

  it("breaks the run when the new edit isn't adjacent, even inside the time window", () => {
    let state = emptyHistory;
    state = recordChange(state, BLOCK0, { kind: "delta", delta: insertDelta(0, "a") }, true, 1000);
    state = recordChange(state, BLOCK0, { kind: "delta", delta: insertDelta(50, "z") }, true, 1010);
    expect(state.undo).toHaveLength(2);
  });

  it("never coalesces across a coalesce:false call", () => {
    let state = emptyHistory;
    state = recordChange(state, BLOCK0, { kind: "delta", delta: insertDelta(0, "a") }, true, 1000);
    state = recordChange(
      state,
      { kind: "block", blockIdx: 1 },
      { kind: "delta", delta: insertDelta(1, "b") },
      false,
      1010,
    );
    state = recordChange(state, { kind: "block", blockIdx: 1 }, { kind: "delta", delta: insertDelta(2, "c") }, true, 1020);
    // The `false` commit starts a fresh entry; the following `true` commit
    // coalesces onto *that* one, not the very first entry.
    expect(state.undo).toHaveLength(2);
    expect((state.undo[1] as HistoryEntry & { kind: "deltas" }).deltas).toHaveLength(2);
  });

  it("does not coalesce onto a snapshot entry", () => {
    let state = emptyHistory;
    state = recordChange(state, BLOCK0, { kind: "snapshot", source: "before" }, false, 1000);
    state = recordChange(state, BLOCK0, { kind: "delta", delta: insertDelta(0, "a") }, true, 1010);
    expect(state.undo).toHaveLength(2);
  });

  it("clears the redo stack on any new commit", () => {
    let state = emptyHistory;
    state = recordChange(state, BLOCK0, { kind: "delta", delta: insertDelta(0, "a") }, false, 1000);
    state = { ...state, redo: [state.undo[0]] };
    state = recordChange(state, BLOCK0, { kind: "delta", delta: insertDelta(1, "b") }, false, 1010);
    expect(state.redo).toHaveLength(0);
  });
});

describe("popUndo / popRedo", () => {
  it("return null on an empty stack", () => {
    expect(popUndo(emptyHistory)).toBeNull();
    expect(popRedo(emptyHistory)).toBeNull();
  });

  it("pops the top entry and leaves the rest, without touching the opposite stack", () => {
    let state = emptyHistory;
    state = recordChange(state, BLOCK0, { kind: "delta", delta: insertDelta(0, "a") }, false, 1000);
    state = recordChange(state, BLOCK0, { kind: "delta", delta: insertDelta(1, "b") }, false, 1010);
    const popped = popUndo(state);
    expect(popped).not.toBeNull();
    expect(popped!.entry).toBe(state.undo[1]);
    expect(popped!.state.undo).toHaveLength(1);
    expect(popped!.state.redo).toBe(state.redo);
  });
});
