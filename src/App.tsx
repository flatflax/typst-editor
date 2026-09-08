import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import SourceEditor, { type EditorDiagnostic, type SourceEditorHandle } from "./editor/SourceEditor";
import WysiwygEditor, { type WysiwygEditorHandle } from "./editor/WysiwygEditor";
import { mountCompiledSvg } from "./editor/sharedSvgHost";
import { unionRangeBoxes, type BlockRect, type RawRangeBox } from "./editor/blockSwapGeometry";
import { byteToUtf16Offset, utf16ToByteOffset } from "./util/offsets";
import {
  typstAstToDoc,
  pmDocToTypst,
  pmDocToTypstWithPositions,
  pmPosToTypstOffset,
  pmNodeTypstAnchor,
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

// `viewBox.x`/`viewBox.y` matter here since M15a: the main preview's SVG
// always has a `0 0 ...` viewBox (so omitting them was harmless before), but
// a WYSIWYG swap crop's viewBox starts wherever its region begins on the
// page — omitting the offset would put every click a fixed amount short of
// where it should land.
function svgPointFromClient(svg: SVGSVGElement, clientX: number, clientY: number) {
  const rect = svg.getBoundingClientRect();
  const viewBox = svg.viewBox.baseVal;
  return {
    xPt: viewBox.x + ((clientX - rect.left) / rect.width) * viewBox.width,
    yPt: viewBox.y + ((clientY - rect.top) / rect.height) * viewBox.height,
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

  // M15a (plan.md): rendered geometry for everything before/after the
  // top-level block currently containing the WYSIWYG selection — plain
  // props into `WysiwygEditor` (see its Props doc comment for why this
  // doesn't need the ref-based workaround the discarded NodeView/overlay
  // versions of this feature needed).
  const [beforeCropRect, setBeforeCropRect] = useState<BlockRect | null>(null);
  const [afterCropRect, setAfterCropRect] = useState<BlockRect | null>(null);
  // The active block's own top-level position — stable across edits *within*
  // that block (only changes when the selection actually moves to a
  // different top-level block), so `fetchSwapGeometry` always re-derives the
  // block's *current* size fresh via `doc.nodeAt(pos)` rather than trusting
  // a cached size that could go stale mid-edit.
  const activePosRef = useRef<number>(0);

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
  const docRef = useRef(doc);
  viewModeRef.current = viewMode;
  typstTextRef.current = typstText;
  derivedRef.current = derived;
  docRef.current = doc;

  // M15a (plan.md): fetches geometry for everything before/after the active
  // top-level block (`activePosRef`) and updates the two crop rects.
  // Re-derives the active block's *current* node/size fresh every call (via
  // `nodeAt`) rather than caching it — `activePosRef` only tracks the
  // block's stable top-level *position*, which doesn't shift from edits
  // happening within that same block.
  //
  // `fresh`, when passed, must be used in place of `docRef`/`derivedRef` —
  // those refs only update on `App.tsx`'s *next* render, but this can be
  // called synchronously inside the same ProseMirror transaction that just
  // produced a newer doc than what the refs currently hold. Resolving a
  // fresh position against a stale doc/position-map was a real bug hit
  // during development (typing into one block made a different, wrong
  // block's range get used). The debounced content-change caller (below)
  // has no such mismatch — refs are always consistent with each other by
  // the time its timer fires — so it omits `fresh` and uses the refs.
  function fetchSwapGeometry(fresh?: { doc: PMDoc; source: string; positions: PositionMapEntry[] }) {
    const doc = fresh?.doc ?? docRef.current;
    const source = fresh?.source ?? derivedRef.current.source;
    const positions = fresh?.positions ?? derivedRef.current.positions;
    if (viewModeRef.current !== "wysiwyg" || !positions) {
      setBeforeCropRect(null);
      setAfterCropRect(null);
      return;
    }
    const activeNode = doc.nodeAt(activePosRef.current);
    const activeRange = activeNode ? pmNodeTypstAnchor(positions, activePosRef.current, activeNode.nodeSize) : null;
    if (!activeRange) {
      setBeforeCropRect(null);
      setAfterCropRect(null);
      return;
    }

    const beforeRange: [number, number] | null = activeRange[0] > 0 ? [0, activeRange[0]] : null;
    const afterRange: [number, number] | null =
      activeRange[1] < source.length ? [activeRange[1], source.length] : null;
    const ranges = [beforeRange, afterRange].filter((r): r is [number, number] => r != null);
    if (ranges.length === 0) {
      setBeforeCropRect(null);
      setAfterCropRect(null);
      return;
    }

    invoke<RawRangeBox[][]>("block_geometry", { source, baseDir: documentDirRef.current, ranges })
      .then((results) => {
        let i = 0;
        setBeforeCropRect(beforeRange ? unionRangeBoxes(results[i++]) : null);
        setAfterCropRect(afterRange ? unionRangeBoxes(results[i++]) : null);
      })
      .catch(() => {
        setBeforeCropRect(null);
        setAfterCropRect(null);
      });
  }

  // Debounced derived-Typst-source -> compile_typst -> SVG preview loop,
  // active regardless of which view is being edited (plan.md M5).
  useEffect(() => {
    const timer = setTimeout(() => {
      invoke<CompileResult>("compile_typst", { source: derived.source, baseDir: documentDirRef.current })
        .then((res) => {
          setResult(res);
          // M15a: refreshes the crops for whatever's currently active, after
          // the compile above rather than as an independent sibling call —
          // the two are separate `invoke`s with no inherent ordering, and
          // firing them together let `block_geometry`'s response (new crop
          // rects) land before `compile_typst`'s (which is what
          // `sharedSvgHost` re-mounts from), pairing new coordinates with
          // stale rendered content for a frame. Sequencing after removes
          // that window; reuses the session `TauriWorld` compile_typst just
          // synced, so this second `typst::compile` call is effectively free
          // (M14's persistent-`World` finding: an unmodified repeat-compile
          // is a full `comemo` cache hit), not a doubled recompile cost.
          fetchSwapGeometry();
        })
        .catch((err) => setInvokeError(String(err)));
    }, COMPILE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [derived.source]);

  // M15a: the one shared copy every inactive paragraph/heading's rendered
  // fragment references (`sharedSvgHost.ts`) — kept in sync with whatever
  // the preview pane itself shows.
  useEffect(() => {
    mountCompiledSvg(result?.svg ?? "");
  }, [result?.svg]);

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
      if (nextMode === "wysiwyg") {
        wysiwygRef.current?.setDoc(nextDoc);
        // M15a: `setDoc` resets the WYSIWYG selection to the start of the
        // doc (no explicit selection is passed to `editorStateFor`), so the
        // active block resets to the first one too.
        activePosRef.current = 0;
      }
      else if (nextMode === "markdown") markdownEditorRef.current?.setValue(docToMarkdown(nextDoc));
      else typstEditorRef.current?.setValue(pmDocToTypst(nextDoc));
      setViewMode(nextMode);
    } catch (err) {
      setInvokeError(String(err));
    }
  }

  // Shared by the split preview pane's click-to-jump (M5) and M15a's WYSIWYG
  // swap crops — both are just "a click landed at this point on a rendered
  // Typst SVG," regardless of which SVG it was.
  function jumpFromSvgClick(svg: SVGSVGElement, clientX: number, clientY: number) {
    const { xPt, yPt } = svgPointFromClient(svg, clientX, clientY);
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

  function handlePreviewClick(event: React.MouseEvent<HTMLDivElement>) {
    const svg = previewRef.current?.querySelector("svg");
    if (!svg) return;
    jumpFromSvgClick(svg, event.clientX, event.clientY);
  }

  // M15a: clicking a before/after crop moves the WYSIWYG selection there,
  // which (via `handleWysiwygSelectionChange` below) makes that click's
  // target block the new active one.
  function handleSwapCropClick(svg: SVGSVGElement, clientX: number, clientY: number) {
    jumpFromSvgClick(svg, clientX, clientY);
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

  // `currentDoc` is the just-committed doc from the same transaction — see
  // its prop doc comment in WysiwygEditor.tsx for why using it (not
  // `docRef.current`/`derivedRef.current`) here matters.
  function handleWysiwygSelectionChange(pmPos: number, currentDoc: PMDoc) {
    const { source, positions } = pmDocToTypstWithPositions(currentDoc);
    const offset = pmPosToTypstOffset(positions, pmPos);
    if (offset != null) highlightFromCursor(offset);

    // M15a: only refetch the crops when the selection actually moved to a
    // *different* top-level block — not on every intra-block cursor move.
    const $pos = currentDoc.resolve(pmPos);
    const activePos = $pos.depth >= 1 ? $pos.before(1) : 0;
    if (activePos !== activePosRef.current) {
      activePosRef.current = activePos;
      fetchSwapGeometry({ doc: currentDoc, source, positions });
    }
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
            {/* M15a (plan.md) acceptance criteria: the swap's known limits
                must be visible in the product, not just in docs. */}
            <p className="swap-scope-note">
              Live inline rendering: paragraphs &amp; headings only, single page.
              Lists, images, tables, and multi-page documents still use the
              preview pane below (M15b).
            </p>
            <WysiwygEditor
              ref={wysiwygRef}
              doc={doc}
              onChange={setDoc}
              onSelectionChange={handleWysiwygSelectionChange}
              documentDir={documentDir}
              beforeCropRect={beforeCropRect}
              afterCropRect={afterCropRect}
              onSwapCropClick={handleSwapCropClick}
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
