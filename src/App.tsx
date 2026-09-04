import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import SourceEditor, { type EditorDiagnostic, type SourceEditorHandle } from "./editor/SourceEditor";
import WysiwygEditor, { type WysiwygEditorHandle } from "./editor/WysiwygEditor";
import { byteToUtf16Offset, utf16ToByteOffset } from "./util/offsets";
import {
  typstAstToDoc,
  pmDocToTypst,
  pmDocToTypstWithPositions,
  pmPosToTypstOffset,
  typstOffsetToPmPos,
  type AstDocument,
  type PositionMapEntry,
} from "./spokes/typstAst";
import { markdownToDoc, docToMarkdown } from "./spokes/markdown";
import { defaultFileName, dirname, spokeForPath, titleFor, withPdfExtension, type Spoke } from "./shell/fileIO";
import { addRecentFile, getRecentFiles, removeRecentFile } from "./shell/recentFiles";
import { buildAppMenu } from "./shell/appMenu";
import type { PMDoc } from "./model/schema";
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

  // M7: File I/O state. `filePath`/`fileSpoke` are null/"typst" until the
  // first open or save. `lastSaved{Typst,Markdown}Text` are snapshots of
  // both serializations as of the last load/save; `dirty` (below) is
  // computed by comparing the live content against them, not a naive
  // edit-count, so e.g. an edit that's undone back to the saved content
  // correctly reports clean again (plan.md M7).
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileSpoke, setFileSpoke] = useState<Spoke>("typst");
  const [lastSavedTypstText, setLastSavedTypstText] = useState(() => pmDocToTypst(INITIAL_DOC));
  const [lastSavedMarkdownText, setLastSavedMarkdownText] = useState(() => docToMarkdown(INITIAL_DOC));
  const [recentFiles, setRecentFiles] = useState<string[]>([]);

  // The open file's directory (plan.md M11) — `#image("relative/path")`
  // resolves against this on every compile/export/asset-read call.
  const documentDir = dirname(filePath);
  const documentDirRef = useRef(documentDir);
  documentDirRef.current = documentDir;

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
      invoke<CompileResult>("compile_typst", { source: derived.source, baseDir: documentDirRef.current })
        .then(setResult)
        .catch((err) => setInvokeError(String(err)));
    }, COMPILE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [derived.source]);

  // Both branches compare against the Typst serialization: `derived.source`
  // already holds it for both the "typst" (raw typstText) and "wysiwyg"
  // (pmDocToTypstWithPositions(doc)) view modes.
  const dirty =
    viewMode === "markdown" ? markdownText !== lastSavedMarkdownText : derived.source !== lastSavedTypstText;

  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    getRecentFiles()
      .then(setRecentFiles)
      .catch(() => {});
  }, []);

  // Native "close requested" guard (window X button / OS quit), mirroring
  // switchView's/handleOpen's in-app unsaved-changes prompt.
  useEffect(() => {
    const unlistenPromise = getCurrentWindow().onCloseRequested(async (event) => {
      if (!dirtyRef.current) return;
      const shouldClose = await ask("You have unsaved changes. Quit without saving?", {
        title: "Unsaved changes",
        kind: "warning",
      });
      if (!shouldClose) event.preventDefault();
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  async function confirmDiscardIfDirty(): Promise<boolean> {
    if (!dirty) return true;
    return ask("You have unsaved changes. Discard them and continue?", {
      title: "Unsaved changes",
      kind: "warning",
    });
  }

  // Loads `path` into all three spokes/panes and resets file/dirty state.
  // Used by both the Open dialog and the recent-files list.
  async function loadFile(path: string) {
    const spoke = spokeForPath(path);
    const text = await readTextFile(path);
    const nextDoc =
      spoke === "markdown"
        ? markdownToDoc(text)
        : typstAstToDoc(await invoke<AstDocument>("parse_typst_ast", { source: text }));
    const nextTypstText = spoke === "typst" ? text : pmDocToTypst(nextDoc);
    const nextMarkdownText = spoke === "markdown" ? text : docToMarkdown(nextDoc);

    setDoc(nextDoc);
    setTypstText(nextTypstText);
    setMarkdownText(nextMarkdownText);
    wysiwygRef.current?.setDoc(nextDoc);
    typstEditorRef.current?.setValue(nextTypstText);
    markdownEditorRef.current?.setValue(nextMarkdownText);

    setFilePath(path);
    setFileSpoke(spoke);
    setLastSavedTypstText(nextTypstText);
    setLastSavedMarkdownText(nextMarkdownText);
    setInvokeError(null);
  }

  async function handleOpen() {
    if (!(await confirmDiscardIfDirty())) return;
    const selected = await open({
      multiple: false,
      filters: [
        { name: "Typst / Markdown", extensions: ["typ", "md", "markdown"] },
        { name: "Typst", extensions: ["typ"] },
        { name: "Markdown", extensions: ["md", "markdown"] },
      ],
    });
    if (typeof selected !== "string") return;
    try {
      await loadFile(selected);
      setRecentFiles(await addRecentFile(selected));
    } catch (err) {
      setInvokeError(String(err));
    }
  }

  async function handleOpenRecent(path: string) {
    if (!(await confirmDiscardIfDirty())) return;
    try {
      await loadFile(path);
      setRecentFiles(await addRecentFile(path));
    } catch (err) {
      setInvokeError(`Couldn't open ${path}: ${String(err)}`);
      setRecentFiles(await removeRecentFile(path));
    }
  }

  // Commits whichever view is active into the canonical doc, serializes it
  // to `spoke`'s source format, writes it to `path`, and snapshots both
  // serializations as the new dirty-comparison baseline.
  async function writeCurrentDoc(path: string, spoke: Spoke) {
    const nextDoc = await commitCurrentView();
    const nextTypstText = pmDocToTypst(nextDoc);
    const nextMarkdownText = docToMarkdown(nextDoc);
    const text = spoke === "markdown" ? nextMarkdownText : nextTypstText;
    await writeTextFile(path, text);
    setDoc(nextDoc);
    setLastSavedTypstText(nextTypstText);
    setLastSavedMarkdownText(nextMarkdownText);
  }

  async function handleSave() {
    if (!filePath) {
      await handleSaveAs();
      return;
    }
    try {
      await writeCurrentDoc(filePath, fileSpoke);
      setInvokeError(null);
      setRecentFiles(await addRecentFile(filePath));
    } catch (err) {
      setInvokeError(String(err));
    }
  }

  async function handleSaveAs() {
    try {
      const target = await save({
        defaultPath: filePath ?? defaultFileName(fileSpoke),
        filters: [
          { name: "Typst", extensions: ["typ"] },
          { name: "Markdown", extensions: ["md"] },
        ],
      });
      if (!target) return;
      const spoke = spokeForPath(target);
      await writeCurrentDoc(target, spoke);
      setFilePath(target);
      setFileSpoke(spoke);
      setInvokeError(null);
      setRecentFiles(await addRecentFile(target));
    } catch (err) {
      setInvokeError(String(err));
    }
  }

  // Exports whatever the preview pane currently shows (derived.source, the
  // same Typst source fed to compile_typst regardless of which view is
  // active) to PDF — matches plan.md M8's verification goal that the
  // exported PDF's content agrees with the live SVG preview by construction,
  // rather than re-deriving a possibly different serialization.
  async function handleExportPdf() {
    try {
      const target = await save({
        defaultPath: withPdfExtension(filePath),
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!target) return;
      await invoke("export_pdf", {
        source: derivedRef.current.source,
        path: target,
        baseDir: documentDir,
      });
      setInvokeError(null);
    } catch (err) {
      setInvokeError(String(err));
    }
  }

  // Dispatched through a ref (not captured directly by the menu-building
  // effect below) so menu actions always call the latest closures — the
  // effect only reruns when `recentFiles` changes, but `handleSave` etc.
  // also close over `filePath`/`fileSpoke`/`viewMode`/... which change far
  // more often; mirrors viewModeRef/typstTextRef/derivedRef above.
  const commandsRef = useRef({ handleOpen, handleSave, handleSaveAs, handleExportPdf, handleOpenRecent });
  commandsRef.current = { handleOpen, handleSave, handleSaveAs, handleExportPdf, handleOpenRecent };

  // Native File menu (Ctrl+O/S/Shift+S accelerators live here now, not in a
  // DOM keydown listener — the two would double-fire on the same keypress).
  // Rebuilt whenever the recent-files list changes; see buildAppMenu's doc
  // comment on why a rebuild (not an in-place update) is fine at this scale.
  useEffect(() => {
    let cancelled = false;
    buildAppMenu(recentFiles, {
      onOpen: () => void commandsRef.current.handleOpen(),
      onSave: () => void commandsRef.current.handleSave(),
      onSaveAs: () => void commandsRef.current.handleSaveAs(),
      onExportPdf: () => void commandsRef.current.handleExportPdf(),
      onOpenRecent: (path) => void commandsRef.current.handleOpenRecent(path),
    })
      .then((menu) => (cancelled ? undefined : menu.setAsAppMenu()))
      .catch((err) => setInvokeError(String(err)));
    return () => {
      cancelled = true;
    };
  }, [recentFiles]);

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
    invoke<number | null>("jump_from_click", {
      source: derivedRef.current.source,
      xPt,
      yPt,
      baseDir: documentDirRef.current,
    })
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
    invoke<CursorTarget[]>("jump_from_cursor", {
      source: derivedRef.current.source,
      cursor,
      baseDir: documentDirRef.current,
    })
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
        <div className="file-bar">
          <span className="file-title">{titleFor(filePath, dirty)}</span>
        </div>
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
              documentDir={documentDir}
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
