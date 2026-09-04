import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";

export type SourceEditorHandle = {
  setCursor: (offset: number) => void;
};

type Props = {
  initialValue: string;
  onChange: (value: string) => void;
  onCursorChange?: (offset: number) => void;
};

// Plain-text CodeMirror 6 editor for Typst source (see plan.md M1 — syntax
// highlighting is a stretch goal, not required to prove the loop).
const SourceEditor = forwardRef<SourceEditorHandle, Props>(function SourceEditor(
  { initialValue, onChange, onCursorChange },
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
          basicSetup,
          EditorView.lineWrapping,
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

  useImperativeHandle(ref, () => ({
    setCursor(offset: number) {
      const view = viewRef.current;
      if (!view) return;
      const pos = Math.max(0, Math.min(offset, view.state.doc.length));
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
    },
  }));

  return <div ref={containerRef} className="source-editor" />;
});

export default SourceEditor;
