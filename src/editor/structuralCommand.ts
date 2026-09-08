// M23: runs an *existing* ProseMirror `Command` (toggleBulletList, setHeading,
// insertTable2x2, ... — all of `wysiwygCommands.ts`, unmodified) against the
// raw Typst source `TypstLiveView.tsx` edits directly, instead of a
// persistent PM `EditorView`.
//
// This is M15's "on-demand structural transformer" made concrete: PM never
// stays mounted here. Each call parses the *whole* current source to a fresh,
// throwaway `EditorState`, runs one command against it, serializes the result
// straight back to Typst source, and discards the PM state — the same
// whole-document parse/serialize round trip `App.tsx` already uses to move
// between the "wysiwyg" and "typst" views (commitCurrentView), just invoked
// per structural edit instead of per view-switch. Reusing that existing,
// tested primitive means table/list/mark logic doesn't need reimplementing
// against raw text at all.
//
// `cursorOffset`/`anchorOffset` (Typst byte offsets, TypstLiveView's own
// cursor model) map to/from PM positions via `typstOffsetToPmPos`/
// `pmPosToTypstOffset` — already built for the WYSIWYG view's own click/
// cursor sync (M5), just unused outside it until now. That mapping is
// point/caret-level, not byte-exact (see typstAst.ts's own doc comment) —
// acceptable here for the same reason it already is there: a structural
// command only needs *a* reasonable selection to act on, not the exact one.
import { invoke } from "@tauri-apps/api/core";
import { EditorState, TextSelection, type Command, type Transaction } from "prosemirror-state";
import {
  pmDocToTypstWithPositions,
  pmPosToTypstOffset,
  typstAstToDoc,
  typstOffsetToPmPos,
  type AstDocument,
} from "../spokes/typstAst";
import type { PMDoc } from "../model/schema";

export type StructuralEditResult = {
  source: string;
  cursorOffset: number;
  anchorOffset: number;
};

// The invoke-wrapping half — parses the whole current source (Rust
// `parse_typst_ast`) and delegates to the pure logic below. Kept as thin as
// possible: no Tauri IPC bridge in vitest (same constraint noted in
// loop.test.ts), so tests exercise `applyStructuralCommand` directly against
// fixture ASTs instead of this wrapper.
export async function runStructuralCommand(
  source: string,
  cursorOffset: number,
  anchorOffset: number,
  command: Command,
): Promise<StructuralEditResult | null> {
  const ast = await invoke<AstDocument>("parse_typst_ast", { source });
  return applyStructuralCommand(typstAstToDoc(ast), cursorOffset, anchorOffset, command);
}

// Returns `null` when the command doesn't apply here (PM's own convention —
// e.g. toggleBulletList inside an existing list of that kind is a deliberate
// no-op, wysiwygCommands.ts:76-81) or when the current source/offsets can't
// be resolved into a PM selection at all (an empty document has no position
// map to interpolate against). Callers treat `null` as "nothing to do", not
// an error — a toolbar button that happens not to apply right now should
// just not change anything, not surface a failure.
export function applyStructuralCommand(
  doc: PMDoc,
  cursorOffset: number,
  anchorOffset: number,
  command: Command,
): StructuralEditResult | null {
  const { positions } = pmDocToTypstWithPositions(doc);

  const pmAnchor = typstOffsetToPmPos(positions, anchorOffset);
  const pmCursor = typstOffsetToPmPos(positions, cursorOffset);
  if (pmAnchor == null || pmCursor == null) return null;

  let selection: TextSelection;
  try {
    selection = TextSelection.create(doc, pmAnchor, pmCursor);
  } catch {
    return null;
  }

  let state = EditorState.create({ schema: doc.type.schema, doc, selection });
  let applied = false;
  const dispatch = (tr: Transaction) => {
    state = state.apply(tr);
    applied = true;
  };
  const ran = command(state, dispatch);
  if (!ran || !applied) return null;

  const result = pmDocToTypstWithPositions(state.doc);
  const newCursorOffset = pmPosToTypstOffset(result.positions, state.selection.head);
  const newAnchorOffset = pmPosToTypstOffset(result.positions, state.selection.anchor);
  if (newCursorOffset == null || newAnchorOffset == null) return null;

  return { source: result.source, cursorOffset: newCursorOffset, anchorOffset: newAnchorOffset };
}
