# System architecture

Review: 2026-10-23. This document explains responsibilities, data contracts, and technical tradeoffs in the current implementation. See [Interaction design](interaction-design.md) for behavior requirements, [Phase 4](phase4-product-validation.md) for evidence and phase differences, and [plan.md](../plan.md) for the roadmap. Uncommitted preview optimizations are distinguished from capabilities that have passed acceptance checks.

## Technology stack and responsibilities

The frontend uses React 19, TypeScript, Vite 7, CodeMirror, and ProseMirror; the desktop shell is Tauri v2. Rust-side Typst, typst-syntax, typst-ide, SVG/PDF, and related crates are pinned to 0.15.1. There is currently no WASM compilation path.

| Directory/file | Responsibility |
|---|---|
| `src/App.tsx` | Active view, document buffers, compilation results, file state, save queue, and unsaved-change protection |
| `src/editor/TypstLiveView.tsx` | Native block drafts, cross-block cursor/selection, toolbar, history, definition navigation, clipping, and scrolling |
| `blockSplit.ts` / `splitLayout.ts` | UTF-8 source splitting and SVG clipping/focus layout calculations |
| `usePreviewCompiler.ts` / `pagePreview.ts` / `SvgDocument.tsx` / `previewMetrics.ts` | Uncommitted scheduling, optional page protocol, page DOM reuse, and local timing; see validation boundaries below |
| `src/model/`, `src/spokes/` | ProseMirror schema, Typst AST mapping, Markdown conversion, and position mapping |
| `src/shell/` | File formats, menus, and recent files |
| `src-tauri/src/ast.rs` | Typst syntax parsing and supported-subset mapping |
| `compile.rs` / `typst_world.rs` | Persistent compilation environment, incremental source editing, SVG, and range-geometry commands |
| `geometry.rs` / `jump.rs` / `references.rs` | Layout geometry, source/preview navigation, and declaration references |
| `export.rs` / `asset.rs` | PDF export and relative image loading |

## Document state and conversion

The conversion relationship is `Typst ⇄ ProseMirror document ⇄ Markdown`. The model handles structured conversion; it is not the sole text state at every moment:

- WYSIWYG modifies the ProseMirror document directly and serializes it to Typst for compilation.
- Typst source maintains its own text and compiles directly; Markdown source maintains Markdown and converts it through the model to Typst for compilation.
- Live cursor retains committed Typst source, with a separate native-textarea draft for the focused block. Drafts commit on blur, block switching, structural operations, or cross-block handoff; ordinary typing does not trigger whole-document compilation.
- View switches parse/serialize to refresh the target buffer. Semantic round trips for a supported subset and byte-for-byte preservation of arbitrary source are therefore different guarantees.

Supported structures include paragraphs, headings 1–3, inline marks, lists, links, restricted tables, and images/figure constructs. Unknown constructs use raw-source nodes, carried by typed fences in Markdown. Top-level `#set` rules are stored separately and emitted before the body; local rules and complex constructs use raw source. There is no promise of structured support for the full language, arbitrary layouts, or multi-file projects.

### Different contracts for conversion and saving

Model equivalence within the supported subset, text preservation in raw nodes, and whole-file byte identity are separate guarantees. Markdown may normalize markers; GFM has no column widths, and image alt text is not a caption. Structural tools and view switches rebuild through the model, so local raw-node preservation does not imply an unchanged whole document. Saving current text directly in its original format avoids additional rewriting solely for saving. See [Phase 2](phase2-content-io.md#cross-format-losses-must-be-explicit) for the full loss inventory.

Earlier documentation described the model as the sole authoritative state for the entire session, which does not match current source/draft buffers. Choose content by purpose: compilation reads committed source; save/export reads current drafts; geometry reads source matching the display; structural commands build a temporary model. These must not be collapsed merely to simplify a “single source of truth” diagram.

### Rationale for editor and native integration choices

Using the underlying ProseMirror schema and commands reuses existing conversion and structural editing, without introducing another framework to restate the schema, NodeViews, and position mapping. Live cursor uses PM only for structural operations; ordinary text input does not use a permanently mounted PM editing DOM.

CodeMirror 6 currently uses a plain-text configuration without full Typst language parsing/syntax highlighting. It includes generic facilities such as basic bracket matching, but automatic bracket insertion was removed to avoid unexpected insertions in Typst function arguments and content brackets. The extensibility of a generic editor component must not be presented as an integrated Typst language service.

Typst uses native Rust rather than WASM because the desktop backend already provides native compilation and font/file access. SVG supports scaling and shared scenes; position precision comes from compiled Frames and mapping, not an assumption that “SVG is inherently more precise than canvas.” typst-ide is tightly coupled to the core version, so upgrades require rechecking navigation and semantic interfaces, not merely successful dependency resolution.

## Backend interfaces and boundaries

This table describes command responsibilities; it does not promise identical exceptions for every failure. Parameter and serialization types are defined by the corresponding Rust files and TS callers.

| Interface | Input and result | Important constraints |
|---|---|---|
| parse_typst_ast | Source→supported AST and raw fragments | Parsing is not compilation; a recoverable syntax tree does not prove successful layout |
| compile_typst | Source, directory, optional output mode/known page version→result, diagnostics, page offsets/optional deltas | Compilation errors may yield null SVG; diagnostics are independent of the last successful result; the new page path remains pending validation |
| block_geometry | Source, directory, list of UTF-8 ranges→range-box arrays in the same order | Still compiles/traverses; empty results may mean no ink or compilation failure, and alone cannot establish that content is absent |
| jump_from_click / jump_from_cursor | Merged-view coordinates or source position→source offset/page position | Convert pt and screen px; currently creates a new World and compiles |
| find_block_references | Current block byte range→actual references and definition ranges | Depends on scope/label semantics; not complete visible-binding autocomplete or #set effect tracking |
| export_pdf | Current full text, destination path, directory→disk-write result | May include uncommitted drafts; compilation errors produce no valid PDF, and write errors must preserve a retryable state |
| read_image_as_data_url | Relative image path, document directory→data URL | Restricted resource reading; does not open arbitrary system paths |

Diagnostic positions are optional 1-based lines/columns and byte ranges; they may be absent when a Span cannot be resolved. Source views can use lines/columns; Live cursor should provide Locate to the block rather than require users to infer locations from hidden line numbers. Convert UTF-8 byte ranges and UTF-16 DOM positions at boundaries; a missing position does not mean no error.

## Compilation and result consistency

1. Wait 150ms after committed source changes.
2. `compile_typst` acquires the persistent `Mutex<TauriWorld>`, applies differential edits to `Source` through `sync_session`, and reuses Typst/comemo caches.
3. Default merged mode calls `typst_svg::svg_merged` to generate a whole-document SVG, returned over IPC with page offsets and diagnostics. Optional workspace pages mode uses page fingerprints and PageDelta to send changed pages only; this path is still under development.
4. The frontend updates the successful result and `lastGoodSource`; diagnostics update independently. Compilation failures do not replace the last successful result.

Live cursor mounts no additional right-hand preview. Compiled SVG content is mounted once; the composite view and individual blocks reference it through `<use>`. SVG content extraction is cached by result. Clipping viewport width and height both use pt, with explicit overflow limits; the page-width container and focused textarea scale proportionally.

Default mode still generates, transfers, parses, and replaces the entire SVG. Clipped references do not establish that the browser avoids offscreen painting. The new `usePreviewCompiler` has one request in flight, retains the latest pending request, and rejects stale results. The page path checks baseline versions, performs a full reset after failure, and reuses page content, but has not completed native acceptance checks and does not unmount pages by viewport. See [performance analysis](preview-performance.md).

pages mode is enabled by `?preview=pages` or the local `typst.preview.mode` setting. The backend conservatively fingerprints all page attributes and SVG options; the frontend namespaces each page's internal IDs and references to avoid conflicts among page definitions. The double requestAnimationFrame in `previewMetrics` estimates a paint opportunity, not actual compositor presentation time. This section describes current uncommitted code; the fixed exe does not necessarily contain all subsequent changes.

## Geometry, block splitting, and coordinates

Backend source positions use UTF-8 byte offsets; DOM/JavaScript uses UTF-16. Conversion must go through `util/offsets.ts`. UTF-16 boundaries for focused drafts are precomputed by source/focus, avoiding repeated whole-document encoding on each keystroke.

`block_geometry` traverses the Frame tree once for a batch of ranges. Glyph ownership is found through sorted ranges; images/shapes are still compared against each range. Batch ranges currently assume no overlap. Geometry requests still compile and scan the document, without a shared final compiled-document cache. Click/cursor queries in `jump.rs` still create a new World and compile.

Text range boxes are clustered by page and baseline, with text height approximated from font size; images use actual bounds. These range boxes are not textareas. Only group translations are accumulated correctly at present; same-baseline columns may merge, and rotation/scaling is incomplete. Page offsets provide absolute coordinates within the merged SVG.

Splitting occurs only at top-level blank lines, skipping blank lines in brackets, strings, single-backtick spans, and comments. Triple-backtick fences remain a gap. Rendered blocks allocate spacing using midpoints between neighboring text boundaries, retaining page margins at page starts/ends. Confirmed invisible blocks are recorded separately from blocks not yet queried. Geometry prioritizes the focused block and its neighbors; other blocks load lazily through IntersectionObserver.

## Live cursor input and history

Single-block input uses an uncontrolled native textarea, preserving browser IME and local history. Height includes borders and is remeasured after actual width changes; internal scrolling begins at a 60vh cap.

Cross-block selection uses SVG selection and a hidden input. Native dragging outside the textarea records a handoff; after mouse release, it commits first, waits for matching source/rendering, then resolves the final position. This avoids continuously converting between coordinates from two different layouts. Asynchronous focus requests use sequence numbers to prevent old clicks from overriding newer ones.

Native block undo takes priority; application history handles it only if the next animation frame confirms that native history made no change. `editHistory.ts` merges adjacent short-interval text diffs and stores document snapshots for structural operations. Cut/paste are separate history steps; remounting on a new document isolates history. There is no history memory limit yet, nor a guarantee of restoring the exact cursor before every step.

The structural toolbar temporarily parses into a PM document, executes commands, then serializes and restores source positions. Mark toggles on collapsed selections have no persistent storedMarks and currently do nothing; position mapping within marked text remains approximate.

## Saving, files, and closing

Saving reads current text from the active view. Live cursor uses a draft snapshot rather than waiting for block commitment. Original-format saves write text directly; cross-format saves convert it. With an existing path, autosave runs after 2000ms of inactivity and pauses during IME composition; there is no separate recovery file.

The disk-write queue follows request order. Save completion updates only the corresponding snapshot; document generations prevent old requests from contaminating a new document. Saving does not commit or remount the textarea or reset native undo.

File menus use native accelerators without duplicate DOM shortcuts. Window closing checks unsaved content through `onCloseRequested`; the SDK waits for the asynchronous handler and then calls `destroy()`. The main window therefore needs `core:window:allow-destroy`; `core:default` alone does not include it.

## Compilation errors and resource boundaries

On compilation failure, the last successful SVG and its source remain; the failing block displays source and diagnostics, while other blocks' geometry is computed from successful source. The last edited position takes priority when selecting the failing block, avoiding error localization at the document end due to parser recovery. Later correct edits still require whole-document compilation to recover before display. No successful result, multiple errors, and changing block counts still need acceptance checks.

World currently provides a single detached source. Images resolve relative to the document directory, with VirtualPath preventing escape from the root. Rich-text images use backend-loaded data URLs; no arbitrary static-file protocol is exposed. Embedded and system-font metadata are combined; scan results are cached per process, and font bytes load on demand. Missing system glyphs may affect every view and are separate from IME composition issues.

## Validation

Frontend unit tests cover the model, conversions, UTF offsets, splitting, history, files, and React interaction; Tauri IPC, file access, and geometry are mocked. Rust tests cover real parsing, fonts, compilation of specified source, geometry, and PDF behavior. These are not a complete real TS/Rust round-trip rendering-diff suite; see [Phase 1](phase1-mvp.md) for the original goal and coverage gap. Historical results and scope are in [Phase 4](phase4-product-validation.md). Cross-platform behavior, the system clipboard, IME, and real multi-page layout require separate native acceptance checks.
