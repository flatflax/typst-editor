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
  `wysiwygCommands.ts`, `SourceEditor.tsx`.
- `shell/` — app-level, non-editing concerns: `fileIO.ts`, `recentFiles.ts`,
  `appMenu.ts`.
- `util/` — small pure helpers: `offsets.ts`, `diagnosticPosition.ts`.

`App.tsx`/`main.tsx`/`App.css`/`loop.test.ts` (the cross-spoke round-trip suite,
spanning `model` + `spokes`) stay at `src/` root. `src-tauri/src` is deliberately flat
— each file is one Tauri command or the `World` impl, already single-purpose.

## Key technical decisions

- **Typst crates** (all pinned `= "0.15"`): `typst`, `typst-syntax`, `typst-layout`
  (`PagedDocument`/`Page` aren't re-exported through the `typst` facade), `typst-kit`
  (font/file/date helpers), `typst-render`/`typst-svg`, `typst-ide` (click/cursor
  position mapping).

- **Bidirectional position mapping via `typst-ide`**: `jump_from_click_in_frame(world,
  doc, frame, click_point) -> Option<Jump>` and `jump_from_cursor(doc, source,
  cursor_byte_offset) -> Vec<PagedPosition>` give a direct, library-backed link between
  Typst source and the rendered preview. Requires a small `IdeWorld` impl on
  `TauriWorld`.
  - **Risk**: `typst-ide` is pre-1.0 and versioned in lockstep with core `typst`;
    `tinymist` (the most mature real-world consumer) hand-rolls its own equivalent in
    `tinymist-query` instead of depending on it. Treat the API as tested but not
    production-validated by prior art — pin tightly, expect signature churn on `typst`
    upgrades.
  - **Precision**: sync precision comes from these Rust-side functions on the compiled
    `Frame`, not the output format. SVG is resolution-independent (pt↔pixel ratio from
    `viewBox`, no re-render on zoom) and just as easy to overlay a caret/highlight on as
    canvas — canvas was rejected (adds DPI/zoom-tracking costs, no precision gain, since
    neither format carries per-glyph source-span metadata). `jump_from_cursor` returns a
    single `Point`; range/word highlighting would need separate bounding-box extraction
    work regardless of format.
  - **Extended to WYSIWYG in M5**: `pmDocToTypstWithPositions` records a PM-position ⇄
    Typst-byte-offset range per inline leaf and interpolates proportionally within a run
    for both lookup directions. Still approximate *inside* a marked-up run — Typst's
    `*`/`_`/`` ` `` wrapper chars and text escaping make a run's Typst byte length
    diverge from its PM character length. Accepted as an MVP limitation.

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
  `-keymap`), custom schema — not Milkdown (its parser/serializer is markdown-first and
  would fight a second Typst source format on the same schema). Source-mode views use
  CodeMirror 6 in plain-text mode.
  - **Fixed post-M6**: `basicSetup`'s `closeBrackets()` auto-closes `(`/`[`/`{`, which
    Typst/Markdown source uses freely as plain syntax (e.g.
    `#table(columns: (1fr, 2fr), [a], [b])`) — typing or pasting a complete snippet left
    extra auto-inserted closing brackets, unbalancing delimiters and corrupting content
    on view switch. Fixed in `SourceEditor.tsx` by using `basicSetup`'s extension list
    minus `closeBrackets()`/`closeBracketsKeymap`.

- **React + TypeScript + Vite** frontend, **Tauri v2** shell.
