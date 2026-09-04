import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import SourceEditor, { type EditorDiagnostic, type SourceEditorHandle } from "./SourceEditor";
import WysiwygEditor, { type WysiwygEditorHandle } from "./WysiwygEditor";
import { byteToUtf16Offset, utf16ToByteOffset } from "./offsets";
import {
  typstAstToDoc,
  pmDocToTypst,
  pmDocToTypstWithPositions,
  pmPosToTypstOffset,
  typstOffsetToPmPos,
  type AstDocument,
  type PositionMapEntry,
} from "./typstAst";
import { markdownToDoc, docToMarkdown } from "./markdown";
import type { PMDoc } from "./schema";
import "./App.css";

const INITIAL_AST: AstDocument = {
  settings: [],
  content: [
    { type: "heading", level: 1, children: [{ type: "text", text: "Typst Editor — M5", marks: [] }] },
    {
      type: "paragraph",
      children: [
        { type: "text", text: "Switch between ", marks: [] },
        { type: "text", text: "WYSIWYG", marks: ["strong"] },
        { type: "text", text: ", ", marks: [] },
        { type: "text", text: "Typst", marks: ["strong"] },
        { type: "text", text: ", and ", marks: [] },
        { type: "text", text: "Markdown", marks: ["strong"] },
        {
          type: "text",
          text: " views above — they all read and write the same Editor Model.",
          marks: [],
        },
      ],
    },
    {
      type: "bullet_list",
      items: [
        [
          {
            type: "paragraph",
            children: [
              { type: "text", text: "Click anywhere in the preview to jump the cursor there", marks: [] },
            ],
          },
        ],
        [
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                text: "Move the WYSIWYG or Typst cursor to see the matching point highlighted",
                marks: [],
              },
            ],
          },
        ],
      ],
    },
    {
      type: "paragraph",
      children: [
        { type: "text", text: "Bold", marks: ["strong"] },
        { type: "text", text: ", ", marks: [] },
        { type: "text", text: "italic", marks: ["em"] },
        { type: "text", text: ", and ", marks: [] },
        { type: "text", text: "inline code", marks: ["code"] },
        { type: "text", text: " all round-trip through every view.", marks: [] },
      ],
    },
  ],
};
const INITIAL_DOC = typstAstToDoc(INITIAL_AST);

const COMPILE_DEBOUNCE_MS = 250;

type ViewMode = "wysiwyg" | "typst" | "markdown";

type CompileResult = {
  svg: string | null;
  diagnostics: EditorDiagnostic[];
};

type CursorTarget = {
  page: number;
  x_pt: number;
  y_pt: number;
};

function svgPointFromClient(svg: SVGSVGElement, clientX: number, clientY: number) {
  const rect = svg.getBoundingClientRect();
  const viewBox = svg.viewBox.baseVal;
  return {
    xPt: ((clientX - rect.left) / rect.width) * viewBox.width,
    yPt: ((clientY - rect.top) / rect.height) * viewBox.height,
  };
}

function clientPointFromPt(svg: SVGSVGElement, xPt: number, yPt: number) {
  const rect = svg.getBoundingClientRect();
  const viewBox = svg.viewBox.baseVal;
  return {
    clientX: rect.left + (xPt / viewBox.width) * rect.width,
    clientY: rect.top + (yPt / viewBox.height) * rect.height,
  };
}

function App() {
  const [viewMode, setViewMode] = useState<ViewMode>("wysiwyg");
  const [doc, setDoc] = useState<PMDoc>(INITIAL_DOC);
  const [typstText, setTypstText] = useState(() => pmDocToTypst(INITIAL_DOC));
  const [markdownText, setMarkdownText] = useState(() => docToMarkdown(INITIAL_DOC));
  const [result, setResult] = useState<CompileResult | null>(null);
  const [invokeError, setInvokeError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<{ clientX: number; clientY: number } | null>(null);

  const wysiwygRef = useRef<WysiwygEditorHandle | null>(null);
  const typstEditorRef = useRef<SourceEditorHandle | null>(null);
  const markdownEditorRef = useRef<SourceEditorHandle | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);

  // The Typst source actually compiled + (WYSIWYG-only) its PM<->Typst
  // position map, recomputed synchronously every render regardless of the
  // debounced compile below — mirrors M1's sourceRef pattern, so click/
  // cursor-sync handlers always read fresh values, never a stale closure
  // from before the last debounce fired (plan.md M5).
  const derived = useMemo((): { source: string; positions: PositionMapEntry[] | null } => {
    if (viewMode === "typst") return { source: typstText, positions: null };
    if (viewMode === "markdown") {
      return { source: pmDocToTypst(markdownToDoc(markdownText)), positions: null };
    }
    return pmDocToTypstWithPositions(doc);
  }, [viewMode, doc, typstText, markdownText]);

  const viewModeRef = useRef(viewMode);
  const typstTextRef = useRef(typstText);
  const derivedRef = useRef(derived);
  viewModeRef.current = viewMode;
  typstTextRef.current = typstText;
  derivedRef.current = derived;

  // Debounced derived-Typst-source -> compile_typst -> SVG preview loop,
  // active regardless of which view is being edited (plan.md M5).
  useEffect(() => {
    const timer = setTimeout(() => {
      invoke<CompileResult>("compile_typst", { source: derived.source })
        .then(setResult)
        .catch((err) => setInvokeError(String(err)));
    }, COMPILE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [derived.source]);

  // Reads whichever view is currently active and returns the canonical
  // PMDoc it represents — parsing via the real Typst compiler (async, Rust)
  // when leaving Typst source, or the pure-JS mappers otherwise.
  async function commitCurrentView(): Promise<PMDoc> {
    if (viewMode === "wysiwyg") return wysiwygRef.current?.getDoc() ?? doc;
    if (viewMode === "markdown") return markdownToDoc(markdownText);
    const ast = await invoke<AstDocument>("parse_typst_ast", { source: typstText });
    return typstAstToDoc(ast);
  }

  async function switchView(nextMode: ViewMode) {
    if (nextMode === viewMode) return;
    try {
      const nextDoc = await commitCurrentView();
      setDoc(nextDoc);
      if (nextMode === "wysiwyg") wysiwygRef.current?.setDoc(nextDoc);
      else if (nextMode === "markdown") markdownEditorRef.current?.setValue(docToMarkdown(nextDoc));
      else typstEditorRef.current?.setValue(pmDocToTypst(nextDoc));
      setViewMode(nextMode);
    } catch (err) {
      setInvokeError(String(err));
    }
  }

  function handlePreviewClick(event: React.MouseEvent<HTMLDivElement>) {
    const svg = previewRef.current?.querySelector("svg");
    if (!svg) return;
    const { xPt, yPt } = svgPointFromClient(svg, event.clientX, event.clientY);
    invoke<number | null>("jump_from_click", { source: derivedRef.current.source, xPt, yPt })
      .then((byteOffset) => {
        if (byteOffset == null) return;
        if (viewModeRef.current === "typst") {
          typstEditorRef.current?.setCursor(byteToUtf16Offset(typstTextRef.current, byteOffset));
        } else if (viewModeRef.current === "wysiwyg" && derivedRef.current.positions) {
          const pmPos = typstOffsetToPmPos(derivedRef.current.positions, byteOffset);
          if (pmPos != null) wysiwygRef.current?.setSelection(pmPos);
        }
        // Markdown view: not wired (plan.md M5 scopes the new sync
        // extension to WYSIWYG specifically, alongside M1's Typst source).
      })
      .catch((err) => setInvokeError(String(err)));
  }

  function highlightFromCursor(cursor: number) {
    const svg = previewRef.current?.querySelector("svg");
    if (!svg) return;
    invoke<CursorTarget[]>("jump_from_cursor", { source: derivedRef.current.source, cursor })
      .then((targets) => {
        const target = targets[0];
        setHighlight(target ? clientPointFromPt(svg, target.x_pt, target.y_pt) : null);
      })
      .catch(() => setHighlight(null));
  }

  function handleTypstCursorChange(utf16Offset: number) {
    highlightFromCursor(utf16ToByteOffset(typstTextRef.current, utf16Offset));
  }

  function handleWysiwygSelectionChange(pmPos: number) {
    if (!derivedRef.current.positions) return;
    const offset = pmPosToTypstOffset(derivedRef.current.positions, pmPos);
    if (offset != null) highlightFromCursor(offset);
  }

  return (
    <main className="app">
      <header className="app-header">
        <h1>Typst Editor — M5</h1>
        <p>WYSIWYG / Typst / Markdown, one Editor Model, one live preview.</p>
        <div className="view-switcher" role="tablist">
          {(["wysiwyg", "typst", "markdown"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={viewMode === mode}
              className={viewMode === mode ? "active" : ""}
              onClick={() => switchView(mode)}
            >
              {mode === "wysiwyg" ? "WYSIWYG" : mode === "typst" ? "Typst source" : "Markdown source"}
            </button>
          ))}
        </div>
      </header>

      {invokeError && <p className="preview-error">Invoke failed: {invokeError}</p>}

      <div className="workspace">
        <div className="editor-pane">
          <div hidden={viewMode !== "wysiwyg"} className="view-panel">
            <WysiwygEditor
              ref={wysiwygRef}
              doc={doc}
              onChange={setDoc}
              onSelectionChange={handleWysiwygSelectionChange}
            />
          </div>
          <div hidden={viewMode !== "typst"} className="view-panel">
            <SourceEditor
              ref={typstEditorRef}
              initialValue={typstText}
              onChange={setTypstText}
              onCursorChange={handleTypstCursorChange}
              diagnostics={viewMode === "typst" ? result?.diagnostics : undefined}
            />
          </div>
          <div hidden={viewMode !== "markdown"} className="view-panel">
            <SourceEditor ref={markdownEditorRef} initialValue={markdownText} onChange={setMarkdownText} />
          </div>
        </div>

        <div className="preview-pane">
          {result?.diagnostics.map((d, i) => (
            <p key={i} className={`diagnostic diagnostic-${d.severity}`}>
              {d.severity}
              {d.line != null ? ` at ${d.line}:${d.column}` : ""}: {d.message}
            </p>
          ))}

          <div
            ref={previewRef}
            className="preview"
            onClick={handlePreviewClick}
            dangerouslySetInnerHTML={{ __html: result?.svg ?? "" }}
          />

          {highlight && (
            <div
              className="cursor-marker"
              style={{ left: highlight.clientX, top: highlight.clientY }}
            />
          )}
        </div>
      </div>
    </main>
  );
}

export default App;
