import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { EditorView, type NodeView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { tableEditing } from "prosemirror-tables";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { schema, type PMDoc, type TypstSet } from "./schema";
import { relativePath } from "./fileIO";
import {
  addTableColumn,
  addTableRow,
  buildKeymapPlugin,
  deleteTableColumn,
  deleteTableRow,
  insertTable2x2,
  setHeading,
  setParagraph,
  toggleBulletList,
  toggleCode,
  toggleEm,
  toggleLink,
  toggleOrderedList,
  toggleStrong,
} from "./wysiwygCommands";

export type WysiwygEditorHandle = {
  getDoc: () => PMDoc;
  setDoc: (doc: PMDoc) => void;
  setSelection: (pos: number) => void;
  focus: () => void;
};

type Props = {
  doc: PMDoc;
  onChange: (doc: PMDoc) => void;
  onSelectionChange?: (pos: number) => void;
  /** The open file's directory (plan.md M11) — `image.attrs.src` resolves
   * against this. `null` before any file has been opened/saved, in which
   * case images can't be previewed or inserted (there's nothing to resolve
   * a relative path against yet). */
  documentDir: string | null;
};

// Live-updated by the component on every render (see `documentDirRef`
// below) so the NodeView factory — captured once at EditorView construction
// time, since `nodeViews` isn't something `updateState` can change — always
// resolves image paths against whichever document is *currently* open, not
// whichever was open when the view was first mounted.
function imageNodeView(documentDirRef: { current: string | null }) {
  return (node: PMNode): NodeView => {
    const dom = document.createElement("figure");
    dom.className = "wysiwyg-image";
    const img = document.createElement("img");
    const figcaption = document.createElement("figcaption");
    dom.append(img, figcaption);

    let destroyed = false;
    function render(node: PMNode) {
      const src = node.attrs.src as string;
      const caption = node.attrs.caption as string | null;
      figcaption.textContent = caption ?? "";
      figcaption.hidden = caption == null;

      const dir = documentDirRef.current;
      if (!dir || !src) {
        img.removeAttribute("src");
        img.alt = src || "(no image)";
        return;
      }
      invoke<string>("read_image_as_data_url", { path: src, baseDir: dir })
        .then((dataUrl) => {
          if (!destroyed) img.src = dataUrl;
        })
        .catch(() => {
          if (!destroyed) {
            img.removeAttribute("src");
            img.alt = `Couldn't load ${src}`;
          }
        });
    }
    render(node);

    return {
      dom,
      // The async data-URL fetch above sets `img.src` outside of any PM
      // transaction — without this, ProseMirror (seeing an untracked DOM
      // mutation on a node it doesn't expect to change on its own) could
      // try to reconcile it back into the document.
      ignoreMutation: () => true,
      update(updatedNode) {
        if (updatedNode.type.name !== "image") return false;
        render(updatedNode);
        return true;
      },
      destroy() {
        destroyed = true;
      },
    };
  };
}

function editorStateFor(doc: PMDoc): EditorState {
  // tableEditing() (plan.md M10) handles cell selection/navigation — no
  // columnResizing(), since per-column width styling is out of the MVP
  // subset (ast.rs's as_table_call only preserves an existing width spec
  // verbatim, never lets the WYSIWYG surface set one).
  return EditorState.create({ doc, schema, plugins: [buildKeymapPlugin(), tableEditing()] });
}

// ProseMirror EditorView for the WYSIWYG surface (plan.md M5). Mirrors
// SourceEditor.tsx's mount-once + imperative-ref pattern: `doc` is only read
// as the *initial* document — later updates from the parent (switching into
// this view from Typst/Markdown source) go through the `setDoc` handle, not
// a reactive prop watch, so the view's own live selection/state isn't reset
// on every render while the user is actively editing here.
const WysiwygEditor = forwardRef<WysiwygEditorHandle, Props>(function WysiwygEditor(
  { doc, onChange, onSelectionChange, documentDir },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  const onChangeRef = useRef(onChange);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const documentDirRef = useRef(documentDir);
  onChangeRef.current = onChange;
  onSelectionChangeRef.current = onSelectionChange;
  documentDirRef.current = documentDir;

  // `#set` rules aren't editable here (plan.md: "no field-level editing in
  // MVP") and can only change via `setDoc` (a view switch), never from a
  // transaction dispatched within this view — so plain state initialized at
  // mount and refreshed in `setDoc` is enough, no per-transaction syncing.
  const [settings, setSettings] = useState<TypstSet[]>((doc.attrs.settings ?? []) as TypstSet[]);

  useEffect(() => {
    if (!containerRef.current) return;

    const view = new EditorView(containerRef.current, {
      state: editorStateFor(doc),
      nodeViews: { image: imageNodeView(documentDirRef) },
      dispatchTransaction(tr) {
        const nextState = view.state.apply(tr);
        view.updateState(nextState);
        if (tr.docChanged) onChangeRef.current(nextState.doc);
        if (tr.selectionSet) onSelectionChangeRef.current?.(nextState.selection.from);
      },
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    getDoc() {
      return viewRef.current?.state.doc ?? doc;
    },
    setDoc(newDoc: PMDoc) {
      viewRef.current?.updateState(editorStateFor(newDoc));
      setSettings((newDoc.attrs.settings ?? []) as TypstSet[]);
    },
    setSelection(pos: number) {
      const view = viewRef.current;
      if (!view) return;
      const clamped = Math.max(0, Math.min(pos, view.state.doc.content.size));
      const selection = TextSelection.near(view.state.doc.resolve(clamped));
      view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
      view.focus();
    },
    focus() {
      viewRef.current?.focus();
    },
  }));

  function runCommand(command: Command) {
    const view = viewRef.current;
    if (!view) return;
    command(view.state, view.dispatch, view);
    view.focus();
  }

  // Prompts for an image file, computes its path relative to the open
  // document's directory (the Editor Model always stores `src` that way —
  // see schema.ts's `image` node), and inserts it at the cursor. No-ops
  // before any file has been opened/saved: there's no directory yet to
  // resolve a relative path against (plan.md M11).
  async function handleInsertImage() {
    const dir = documentDirRef.current;
    if (!dir) return;
    const selected = await open({
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }],
    });
    if (typeof selected !== "string") return;
    const view = viewRef.current;
    if (!view) return;
    const node = schema.nodes.image.create({ src: relativePath(dir, selected), caption: null });
    view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
    view.focus();
  }

  return (
    <div className="wysiwyg-editor">
      <div className="wysiwyg-toolbar">
        <button type="button" onClick={() => runCommand(toggleStrong)}>
          <strong>B</strong>
        </button>
        <button type="button" onClick={() => runCommand(toggleEm)}>
          <em>I</em>
        </button>
        <button type="button" onClick={() => runCommand(toggleCode)}>
          {"</>"}
        </button>
        <button type="button" onClick={() => runCommand(toggleLink)} title="Link (Mod-k)">
          Link
        </button>
        <button type="button" onClick={() => runCommand(setParagraph)}>
          P
        </button>
        <button type="button" onClick={() => runCommand(setHeading(1))}>
          H1
        </button>
        <button type="button" onClick={() => runCommand(setHeading(2))}>
          H2
        </button>
        <button type="button" onClick={() => runCommand(setHeading(3))}>
          H3
        </button>
        <button type="button" onClick={() => runCommand(toggleBulletList)}>
          • List
        </button>
        <button type="button" onClick={() => runCommand(toggleOrderedList)}>
          1. List
        </button>
        <button type="button" onClick={() => runCommand(insertTable2x2)} title="Insert table">
          Table
        </button>
        <button type="button" onClick={() => runCommand(addTableRow)} title="Add row below">
          +Row
        </button>
        <button type="button" onClick={() => runCommand(addTableColumn)} title="Add column after">
          +Col
        </button>
        <button type="button" onClick={() => runCommand(deleteTableRow)} title="Delete row">
          -Row
        </button>
        <button type="button" onClick={() => runCommand(deleteTableColumn)} title="Delete column">
          -Col
        </button>
        <button
          type="button"
          onClick={() => void handleInsertImage()}
          disabled={!documentDir}
          title={documentDir ? "Insert image" : "Save the document first to insert images"}
        >
          Image
        </button>
      </div>
      {settings.length > 0 && (
        // Read-only (plan.md: only the preview reflects #set's actual
        // effect — this surface doesn't simulate it), kept out of the main
        // editing flow since it isn't content.
        <details className="wysiwyg-settings" open>
          <summary>Document Settings ({settings.length})</summary>
          {settings.map((set, i) => (
            <pre key={i}>{set.raw}</pre>
          ))}
        </details>
      )}
      <div ref={containerRef} className="wysiwyg-content" />
    </div>
  );
});

export default WysiwygEditor;
