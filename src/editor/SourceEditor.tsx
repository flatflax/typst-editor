import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { linter, lintGutter, lintKeymap, setDiagnostics } from "@codemirror/lint";
import { toCMDiagnostics } from "../util/diagnosticPosition";

// `codemirror`'s own `basicSetup` (see its source: node_modules/codemirror/
// dist/index.js), minus `closeBrackets()`/`closeBracketsKeymap` — its own
// doc comment invites exactly this ("once you decide you want to configure
// your editor more precisely, you take this package's source ... and adjust
// it as desired"). Bracket auto-closing is a programming-editor convenience
// that actively fights typing or pasting Typst/Markdown source: both freely
// use `(`, `[`, `{` as plain syntax characters (e.g. `#table(columns: (1fr,
// 2fr), [a], [b])`), and a user typing or pasting a *complete* snippet ends
// up with extra auto-inserted closing brackets duplicating their own —
// confirmed by directly reproducing it (simulated typing through real
// keystrokes turned `#table(...)` into mismatched-parenthesis source that
// then parsed as something else entirely, matching a user-reported bug).
const plainTextSetup = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  foldGutter(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  autocompletion(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap]),
];

export type SourceEditorHandle = {
  setCursor: (offset: number) => void;
  setValue: (value: string) => void;
};

export type EditorDiagnostic = {
  severity: "error" | "warning";
  message: string;
  /** 1-indexed; absent when the diagnostic has no resolvable source position. */
  line?: number;
  column?: number;
};

type Props = {
  initialValue: string;
  onChange: (value: string) => void;
  onCursorChange?: (offset: number) => void;
  diagnostics?: EditorDiagnostic[];
};

// Plain-text CodeMirror 6 editor for Typst source (see plan.md M1 — syntax
// highlighting is a stretch goal, not required to prove the loop).
const SourceEditor = forwardRef<SourceEditorHandle, Props>(function SourceEditor(
  { initialValue, onChange, onCursorChange, diagnostics },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Read via refs inside the (mount-once) updateListener so changing the
  // callback identity doesn't tear down and recreate the editor/cursor.
  const onChangeRef = useRef(onChange);
  const onCursorChangeRef = useRef(onCursorChange);
  onChangeRef.current = onChange;
  onCursorChangeRef.current = onCursorChange;

  useEffect(() => {
    if (!containerRef.current) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          plainTextSetup,
          EditorView.lineWrapping,
          // Diagnostics are pushed externally via setDiagnostics (below)
          // whenever a new compile_typst result arrives. A non-null source
          // here would have CodeMirror re-run it on its own ~750ms-after-
          // edit schedule and overwrite our diagnostics with its (empty)
          // result — `null` sets up the gutter/underline machinery without
          // any automatic re-linting.
          linter(null),
          lintGutter(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
            if (update.selectionSet) {
              onCursorChangeRef.current?.(update.state.selection.main.head);
            }
          }),
        ],
      }),
      parent: containerRef.current,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch(setDiagnostics(view.state, toCMDiagnostics(view.state, diagnostics ?? [])));
  }, [diagnostics]);

  useImperativeHandle(ref, () => ({
    setCursor(offset: number) {
      const view = viewRef.current;
      if (!view) return;
      const pos = Math.max(0, Math.min(offset, view.state.doc.length));
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
    },
    // Pushes new content in from outside (plan.md M5's view switcher, which
    // reuses this component for both the Typst and Markdown source panes).
    // Dispatched as a normal document-replacing transaction, so it flows
    // through the same updateListener as a user edit and keeps onChange in
    // sync — no separate "controlled value" plumbing needed.
    setValue(value: string) {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    },
  }));

  return <div ref={containerRef} className="source-editor" />;
});

export default SourceEditor;
