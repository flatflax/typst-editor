import type { EditorState } from "@codemirror/state";
import type { Diagnostic as CMDiagnostic } from "@codemirror/lint";
import type { EditorDiagnostic } from "./SourceEditor";

// Typst line/column (1-indexed, counted in characters — see
// typst_syntax::Lines::byte_to_line_column) -> CodeMirror doc offset
// (0-indexed, UTF-16 code units). These coincide for every character
// outside the astral plane (surrogate pairs), which covers the MVP subset;
// unlike the byte<->UTF-16 conversion in offsets.ts, no encode/decode is
// needed here since both sides already count in the same unit for BMP text.
export function positionToOffset(state: EditorState, line: number, column: number): number {
  const clampedLine = Math.min(Math.max(line, 1), state.doc.lines);
  const lineInfo = state.doc.line(clampedLine);
  return Math.min(lineInfo.from + Math.max(column - 1, 0), lineInfo.to);
}

export function toCMDiagnostics(
  state: EditorState,
  diagnostics: EditorDiagnostic[],
): CMDiagnostic[] {
  return diagnostics.map((d) => {
    const from =
      d.line != null && d.column != null ? positionToOffset(state, d.line, d.column) : 0;
    return {
      from,
      to: Math.min(from + 1, state.doc.length),
      severity: d.severity,
      message: d.message,
    };
  });
}
