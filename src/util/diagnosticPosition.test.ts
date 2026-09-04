import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { positionToOffset, toCMDiagnostics } from "./diagnosticPosition";

function stateFor(doc: string): EditorState {
  return EditorState.create({ doc });
}

describe("positionToOffset", () => {
  it("maps 1-indexed (line, column) to a 0-indexed doc offset", () => {
    const state = stateFor("= Heading\n\nSome text.");
    // Line 3, column 1 -> the "S" of "Some text." (offset 11: "= Heading\n\n" is 11 chars).
    expect(positionToOffset(state, 3, 1)).toBe(11);
    // Line 3, column 6 -> the "t" of "text" (5 chars into the line).
    expect(positionToOffset(state, 3, 6)).toBe(16);
  });

  it("agrees with CodeMirror's own offsets for CJK text (BMP characters)", () => {
    // typst_syntax::Lines::byte_to_line_column counts characters, and
    // CodeMirror's doc.line() counts UTF-16 code units — these coincide for
    // any character in the Basic Multilingual Plane, which includes CJK.
    const state = stateFor("= 一级标题\n\n普通段落。");
    // Line 3, column 3 -> just after "普通" (2 characters in).
    const offset = positionToOffset(state, 3, 3);
    const line3 = state.doc.line(3);
    expect(state.doc.sliceString(line3.from, offset)).toBe("普通");
  });

  it("clamps out-of-range lines and columns instead of throwing", () => {
    const state = stateFor("short");
    // Line clamps to the last line, then column 1 is that line's start.
    expect(positionToOffset(state, 99, 1)).toBe(state.doc.line(1).from);
    // Column clamps to the line's end.
    expect(positionToOffset(state, 1, 999)).toBe(state.doc.line(1).to);
    expect(positionToOffset(state, 0, 0)).toBe(0);
  });
});

describe("toCMDiagnostics", () => {
  it("produces a non-empty range anchored at the resolved position", () => {
    const state = stateFor("= Heading\n\n#unknown()");
    const [diagnostic] = toCMDiagnostics(state, [
      { severity: "error", message: "unknown function", line: 3, column: 2 },
    ]);
    expect(diagnostic.from).toBe(state.doc.line(3).from + 1);
    expect(diagnostic.to).toBeGreaterThan(diagnostic.from);
    expect(diagnostic.severity).toBe("error");
  });

  it("falls back to the document start for diagnostics with no position", () => {
    const state = stateFor("content");
    const [diagnostic] = toCMDiagnostics(state, [
      { severity: "warning", message: "no position" },
    ]);
    expect(diagnostic.from).toBe(0);
  });
});
