# Architecture

## Hub-and-spoke

The Editor Model (a ProseMirror document) is the hub:

```
Typst source  <---parse/serialize--->  Editor Model (ProseMirror doc)  <---parse/serialize--->  Markdown source
                                              |
                                              | (always serializes to Typst source)
                                              v
                                     Typst source  --[Rust: typst::compile]-->  PNG/SVG preview
```

- **Editor Model is canonical during a session.** Loading a `.typ` or `.md` file parses
  it into the model; every other view (WYSIWYG, opposite source format, preview)
  derives from the model, not from each other.
- **Preview always goes through real Typst source + the real Typst compiler.** On every
  debounced change, the current model serializes to Typst source and compiles, regardless
  of which view is active.
- **The Live cursor view (Phase 3 M20–M23, Phase 4's focus-reveals-source) is a second,
  source-first editing path, not routed through the Editor Model.** A focused block
  becomes a real, native `<textarea>` on its own raw Typst source; every other block
  stays rendered. Only a genuine cross-block selection falls back to M20's original
  mechanism, a self-drawn cursor/selection layer on the compiled `Frame`'s own
  geometry. See Key technical decisions below and
  [phase3-single-view.md](phase3-single-view.md) M15 for why.

## Process split

**Rust backend (Tauri commands)** owns everything requiring the real Typst engine:
- `parse_typst_ast(source) -> AstJson` — via `typst_syntax::parse`, pruned to the
  supported node kinds (everything else becomes an opaque span).
- `compile_typst(source) -> CompileResult` — builds a `World`, runs
  `typst::compile::<PagedDocument>`, renders via `typst_render`/`typst_svg` (SVG
  preferred — inline into DOM, scales cleanly), returns image bytes +
  `SourceDiagnostic`s.
- `export_pdf(source, path)` — `typst_pdf::pdf(&paged_document, ...)` through the same
  `TauriWorld`/`PagedDocument` pipeline, writes bytes directly to disk.
- `read_image_as_data_url(path)` — resolves a relative image path against the open
  document's directory and returns a base64 `data:` URL for the live WYSIWYG preview.
- `geometry_for_range`/`block_geometry` (`geometry.rs`, Phase 3 M14A/M20) — walk the
  compiled `Frame` tree for a source byte range and return rendered geometry (page,
  x/y, width/height, baseline), generalizing `jump_from_click`/`jump_from_cursor`'s
  span-matching from a point to a range. Backs the Live cursor view's block layout and
  cursor/selection positioning.

**TypeScript frontend** owns the Editor Model and both source-format conversions —
ProseMirror already lives there, and Markdown parsing has mature TS-typed libraries:
- `typstAstToDoc(ast) -> PMDoc` / `pmDocToTypst(doc) -> string` — hand-written mapper +
  serializer for the supported subset.
- `mdastToDoc(ast) -> PMDoc` / `pmDocToMdast(doc) -> mdast` via `remark-parse`/
  `remark-stringify`, reusing the same PMDoc schema as the Typst path.
- ProseMirror schema, keymaps, the WYSIWYG `EditorView`.

## `src/` layout

Reorganized 2026-09-04 into five folders mirroring the architecture:
- `model/` — the Editor Model schema (`schema.ts`), the hub.
- `spokes/` — the two conversion spokes: `markdown.ts`, `typstAst.ts`.
- `editor/` — WYSIWYG and source-mode editing surfaces: `WysiwygEditor.tsx`,
  `wysiwygCommands.ts`, `SourceEditor.tsx`. Also, since M20 (Phase 3's
  revised mechanism — see below): `TypstLiveView.tsx` (the "Live cursor"
  view, no PM involved), `typstCursor.ts` (its pure geometry/offset
  math, tested independently of React/Tauri), `structuralCommand.ts`
  (M23 — runs a `wysiwygCommands.ts` PM command against a throwaway
  `EditorState` for the Live cursor view's block-level toolbar), and
  `editHistory.ts` (Phase 4 — cross-block undo/redo history: delta-based
  entries, coalescing, pure and tested independently, same split as
  `typstCursor.ts`).
- `shell/` — app-level, non-editing concerns: `fileIO.ts`, `recentFiles.ts`,
  `appMenu.ts`.
- `util/` — small pure helpers: `offsets.ts`, `diagnosticPosition.ts`,
  `svgGeometry.ts` (screen-pixel ⇄ SVG-viewBox-pt conversion, shared by the
  split preview pane and `TypstLiveView.tsx`).

`App.tsx`/`main.tsx`/`App.css`/`loop.test.ts` (the cross-spoke round-trip suite,
spanning `model` + `spokes`) stay at `src/` root. `src-tauri/src` is deliberately flat
— each file is one Tauri command or the `World` impl, already single-purpose; `geometry.rs`
(M14A/M20 — per-source-range rendered geometry, `geometry_for_range`/`page_offsets_pt`,
backing the `block_geometry` command) is the one exception with meaningful internal
structure of its own.

## Key technical decisions

- **Typst crates** (all pinned `= "0.15"`): `typst`, `typst-syntax`, `typst-layout`
  (`PagedDocument`/`Page` aren't re-exported through the `typst` facade), `typst-kit`
  (font/file/date helpers), `typst-render`/`typst-svg`, `typst-ide` (click/cursor
  position mapping).

- **Bidirectional position mapping via `typst-ide`**: `jump_from_click_in_frame`/
  `jump_from_cursor` give a direct, library-backed link between Typst source and the
  rendered preview (a small `IdeWorld` impl on `TauriWorld`). This backs the WYSIWYG
  view's split-pane click/cursor sync only — Live cursor uses a different mechanism
  entirely (`geometry_for_range`/`block_geometry`, no PM position map involved); see
  Hub-and-spoke above and [design-principles.md](design-principles.md)'s M15 revision
  for why they don't share one.
  - **Risk**: `typst-ide` is pre-1.0, versioned in lockstep with core `typst` — even
    `tinymist` hand-rolls its own equivalent rather than depending on it. Pin tightly,
    expect signature churn on `typst` upgrades.
  - **Precision** comes from these Rust-side functions running on the compiled
    `Frame`, not the output format — SVG was chosen over canvas for being
    resolution-independent, not for any precision difference between them.
  - **WYSIWYG-specific approximation** (M5): `pmDocToTypstWithPositions` maps PM
    positions to Typst byte ranges per inline leaf, interpolating within a run — still
    approximate *inside* a run, since marks/escaping make a run's Typst byte length
    diverge from its PM character length. Accepted MVP limitation.

- **No WASM.** Tauri gives a native Rust backend; embed Typst natively (same pattern as
  `typst-cli`/`tinymist`), not compiled to WASM (that's for browser-only apps).

- **World implementation**: `TauriWorld` implements `typst::World`'s 7 methods
  (`library`, `book`, `main`, `source`, `file`, `font`, `today`), shaped like
  `typst-cli`'s `SystemWorld`. Uses `typst_kit::fonts::embedded()` for default
  (Latin/math) faces. **Revised during M1**: embedded fonts alone have no CJK coverage
  (blank CJK text), fixed by also merging `typst_kit::fonts::system()` so glyph
  fallback finds installed CJK fonts, matching `typst-cli`'s default behavior. Trades
  portability (CJK rendering depends on the host machine's fonts) for correctness.
  Font-metadata scan is cached once per process (`LazyLock`); font bytes still load
  lazily per compile. Pinned by a `cargo test` asserting CJK fallback coverage.

- **Diagnostics carry a source line, not just a message**: `SourceDiagnostic` carries a
  `Span`, resolved back to 1-indexed `(line, column)` via the compiling `Source`
  (`source.range(span)` then `byte_to_line`/`byte_to_column`), added to
  `CompileDiagnostic`. Frontend shows this as a CodeMirror gutter/inline marker (M1),
  and once WYSIWYG exists, resolves through the M5 position map to highlight the
  originating block instead of a raw generated-source line number.

- **Editor**: raw ProseMirror (`prosemirror-model`/`-view`/`-state`/`-commands`/
  `-keymap`), custom schema — not Milkdown (markdown-first, would fight a second Typst
  source format on the same schema). Source-mode views use CodeMirror 6 in plain-text
  mode, `basicSetup` minus `closeBrackets()` (its auto-closing of `(`/`[`/`{` corrupted
  content that uses them as plain syntax, e.g. `#table(columns: (1fr, 2fr), [a], [b])`).

- **React + TypeScript + Vite** frontend, **Tauri v2** shell.
