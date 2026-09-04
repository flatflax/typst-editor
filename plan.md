# Typst WYSIWYG Editor — Plan

## Context

**The product goal**: a desktop Typst editor that edits like Typora or Notion — a
single WYSIWYG view, no separate preview pane — while every character on the page is
still backed by the real Typst compiler, not an approximation of one. See **Phase 3 —
Single-View WYSIWYG** below for that target and the architecture that makes it
tractable.

**The MVP's goal (complete, M0–M6)** was narrower and came first by design: prove that
`Source code ⇄ Edit model ⇄ Typst typesetting result` can form a **stable closed loop** on top of Tauri,
before attempting single-view editing at all. Not "build a Typst IDE" — a proof that:

- a shared **Editor Model** (rich-text document, not raw text) can be losslessly parsed from *and* serialized back to **Typst source**, and separately to/from **Markdown source**, for a small syntax subset;
- that same Editor Model can always be serialized to Typst source and handed to the **real Typst compiler** (not a reimplementation) to produce an accurate rendered preview;
- switching between WYSIWYG editing / Typst source view / Markdown source view does not corrupt or drift content, proven by automated round-trip tests plus a manual smoke check.

Two scope decisions already made with the user (do not revisit without asking):
1. **WYSIWYG = rich-text editing surface + a separate accurate preview pane** (a split-pane approximation of Typora/Notion), *not* single-view editing on top of Typst's real paginated layout, for the MVP specifically — that remains architecturally harder and was correctly out of scope while the loop itself was unproven. The user has since confirmed single-view WYSIWYG (no separate pane) as the long-term target once the loop is stable; see **Phase 3 — Single-View WYSIWYG** below for the architecture that makes it tractable rather than an open-ended rewrite.
2. **Markdown is a first-class second source format**, requiring real Markdown ⇄ Editor Model conversion (not just a UX inspiration) — Typst source and Markdown source are two independent "spokes" around the same Editor Model "hub."

**Status:** MVP (M0–M6) complete — the closed loop is proven, including the M6
cross-spoke stability suite and mixed-content compile-diff fixture. **Phase 2** (content
coverage + file I/O) is in progress: M7 File I/O, M8 PDF export, and M9 Links are done;
M10 Tables and M11 Images/figures are next. **Phase 3** (the single-view product goal
above) hasn't started — see both phases' sections below.

## Phase 1 — MVP (M0–M6, complete)

### Architecture

**Hub-and-spoke**, Editor Model (a ProseMirror document) is the hub:

```
Typst source  <---parse/serialize--->  Editor Model (ProseMirror doc)  <---parse/serialize--->  Markdown source
                                              |
                                              | (always serializes to Typst source)
                                              v
                                     Typst source  --[Rust: typst::compile]-->  PNG/SVG preview
```

- **Editor Model is canonical during a session.** Loading a `.typ` or `.md` file parses it into the model; every other view (WYSIWYG, opposite source format, preview) derives from the model, not from each other.
- **Preview always goes through real Typst source + the real Typst compiler.** Whether the user is editing in WYSIWYG, Typst source, or Markdown, on every debounced change we serialize the current model to Typst source and compile it. This is what makes the loop a *proof*, not a mock.
- **MVP syntax subset** (must be expressible identically in Typst markup, Markdown, and the ProseMirror schema): paragraphs, headings (levels 1–3), bold, italic, inline code, bullet lists, ordered lists, hard line breaks, plus **opaque `#` function-call and top-level `#set` rule support** (see below). Explicitly excluded from MVP: math, tables, images/figures, links, footnotes, citations, raw blocks, multi-file projects/imports, PDF export.
- **Unsupported input policy:** when parsing source outside the subset, wrap the offending region as an opaque `unsupported_block` leaf node in the Editor Model that round-trips its raw text verbatim but is not WYSIWYG-editable. This keeps the loop *stable* (no crashes / no silent data loss) without requiring full-language support — an explicit, testable policy rather than best-effort guessing.
- **`#` function-call support (opaque, verbatim round-trip):** `typst_syntax::parse` already gives us clean node boundaries for a `#name(...)`/`#name[...]` call, so we don't need to understand Typst's expression language to preserve one — we just need to recognize the node kind and carry its raw source text through untouched. This is a distinct, *named* node type (`typst_call`), not a fallback:
  - **Editor Model**: a `typst_call` leaf (block or inline, mirroring where the `#` appears) storing `{ name: string, raw: string }` — `raw` is the exact source slice from `#` to the end of the call, never re-parsed or reformatted.
  - **Typst ⇄ model**: parser matches the call node's span, serializer re-emits `raw` verbatim — trivially stable by construction.
  - **Markdown ⇄ model**: Markdown has no equivalent construct, so a `typst_call` serializes to a fenced code block tagged ```` ```typst-call ```` containing `raw`; the Markdown parser recognizes that fence on the way back in and reconstructs the `typst_call` node. This keeps the loop stable through Markdown too, rather than silently dropping the call.
  - **WYSIWYG**: rendered as a small inert, non-editable "chip" showing `#name(...)` (same non-editable treatment as `unsupported_block`) — no field-level editing of arguments in MVP.
  - Scope stays narrow: no `#let`/`#show`/control-flow (`#if`/`#for`) support — those still fall through to `unsupported_block` if encountered, since they aren't a single self-contained call node. (`#set` is supported separately, see next.)
- **`#set` rule support (opaque, verbatim round-trip, non-flow):** `#set func(param: value, ...)` is a self-contained syntax node like a call (`typst_syntax` gives clean span boundaries), so it reuses the same verbatim-round-trip approach as `typst_call` — but semantically it configures *subsequent* rendering rather than producing content at its own position, so it gets its own node type and placement rules rather than being treated as inline/block flow content:
  - **Editor Model**: a `typst_set` node, stored in a separate top-level `settings: TypstSet[]` list on the document (not interleaved in the flow content), each `{ function: string, raw: string }` — `raw` is the exact `#set ...` source slice, never re-parsed.
  - **Typst ⇄ model**: parser lifts any `#set` statement out of the node stream into `settings`, in source order; serializer emits all `settings` entries verbatim at the top of the generated Typst source, before the flow content — matching the common real-world convention of `#set` rules living at the top of a document.
  - **Markdown ⇄ model**: same fenced-block convention as `typst_call`, tagged ```` ```typst-set ```` , placed at the top of the Markdown document; the Markdown parser recognizes these fences and reconstructs `settings` entries (order preserved by fence order).
  - **WYSIWYG**: exposed as a small "Document Settings" panel/drawer listing the raw `#set` lines (same non-editable chip treatment, no field-level editing in MVP) — kept out of the main editing flow since it isn't content.
  - **No simulated semantics in the editor**: the WYSIWYG surface does not attempt to visually apply `#set` rules (e.g. a changed font/size) — per the existing WYSIWYG-scope decision, only the preview pane (which always compiles real serialized Typst source through the real compiler) reflects their actual effect. This is not a gap, just a restatement of the existing "rich text + accurate preview pane" split.
  - Only a single `#set` statement per fence/position (no nested blocks like `#set text(..); content` scoping) — scoped `#set` (Typst's block-scoped form) still falls through to `unsupported_block`.

#### Process split (Rust backend vs. TypeScript frontend)

Rust backend (Tauri commands) owns everything that must use the **real Typst engine**, so fidelity is never in question:
- `parse_typst_ast(source: String) -> AstJson` — via `typst_syntax::parse` (pure, infallible, no World needed), pruned/simplified to a JSON shape covering only the MVP node kinds (everything else becomes an opaque span).
- `compile_typst(source: String) -> CompileResult` — builds a `World`, runs `typst::compile::<PagedDocument>`, renders via `typst_render::render_merged` (PNG) or `typst_svg::svg_merged` (SVG, preferred — inline into DOM, scales cleanly), returns image bytes + `SourceDiagnostic`s (for error surfacing) over IPC.

TypeScript frontend owns the Editor Model and both source-format conversions, since ProseMirror already lives there and Markdown parsing has mature TS-typed libraries (`@types/mdast`, remark's own types) — no need to cross the IPC boundary for every keystroke:
- `typstAstToDoc(ast) -> PMDoc` / `pmDocToTypst(doc) -> string` — mapper + hand-written serializer for the constrained subset (deterministic, no need for a full Typst pretty-printer).
- `mdastToDoc(ast) -> PMDoc` / `pmDocToMdast(doc) -> mdast` using `remark-parse`/`remark-stringify` (well-maintained CommonMark libs) — reuses the *same* PMDoc schema/subset as the Typst path.
- ProseMirror schema, keymaps, and the WYSIWYG `EditorView`.

#### Key technical decisions (from research, see below)

- **Typst crates** (all pinned `= "0.15"`, current stable `0.15.1`): `typst`, `typst-syntax`, `typst-layout` (needed directly — `PagedDocument`/`Page` are not re-exported through the `typst` facade), `typst-kit` (font/file/date helpers, feature-gated), `typst-render` and/or `typst-svg`, `typst-ide` (click/cursor position mapping, see below).
- **Bidirectional position mapping via `typst-ide`**: `typst-ide::jump_from_click_in_frame(world, doc, frame, click_point) -> Option<Jump>` (click on a rendered page → `Jump::File(id, byte_offset)`) and `typst-ide::jump_from_cursor(doc, source, cursor_byte_offset) -> Vec<PagedPosition>` (source cursor → page + point to scroll/highlight) give us a *direct*, library-backed link between Typst source and the rendered preview, on top of the debounced full-recompile loop. Requires implementing the small `IdeWorld` trait (extends `World` with `upcast()`) on top of `TauriWorld`. This is a concrete, testable manifestation of "source ↔ 排版结果" and is cheap to add once `compile_typst`'s `World`/`PagedDocument` exist (M1) — do it there rather than deferring it.
  - **Risk, flag explicitly**: `typst-ide` is a normal first-party crate (not marked experimental) but pre-1.0 and versioned in lockstep with core `typst`; notably, `tinymist` (the most mature real-world Typst-as-a-library consumer) does **not** depend on `typst-ide` for this and instead hand-rolls an equivalent, less-complete `jump_from_click`/`jump_from_cursor` in `tinymist-query`. Treat `typst-ide`'s API as usable and reasonably tested (it has its own test suite) but not production-validated by prior art — pin the version tightly and expect to revisit signatures on any `typst` upgrade.
  - **Precision note**: the precision of click/cursor sync comes entirely from these Rust-side functions operating on the compiled `Frame`/`Point` data — not from the preview's output format. SVG (the chosen format) is resolution-independent (pt↔pixel ratio comes for free from its `viewBox`, no re-render on zoom) and just as easy to overlay a highlight/caret on (inject a sibling `<rect>`/`<line>` into the inline SVG DOM) as a canvas would be — canvas was considered and rejected: it would add DPI/zoom-tracking and re-render-per-zoom costs for no precision gain, since neither format carries queryable per-glyph source-span metadata (Typst renders glyphs as filled paths either way). `jump_from_cursor` currently returns a single `Point` (good for an exact caret); highlighting a whole word/range as a filled box would need separate future Rust-side work (bounding-box extraction from the `Frame`) regardless of output format.
  - **Extended to WYSIWYG in M5**: `pmDocToTypstWithPositions` (src/typstAst.ts) records a PM-position ⇄ Typst-byte-offset range per inline leaf (text run/hard_break/typst_call) and interpolates proportionally within the containing range for both lookup directions, so a click landing mid-run lands the WYSIWYG cursor near that point rather than snapping to the run's start. Still an approximation *inside* a marked-up run specifically: Typst's `*`/`_`/`` ` `` wrapper characters (and text escaping) make the Typst byte length of a run diverge from its PM character length, so the interpolation is proportionally close but not byte-exact there. Accepted as an MVP limitation, not fixed — see the "Explicitly out of scope" list.
- **No WASM.** Tauri already gives a native Rust backend; embed Typst natively there (same pattern as `typst-cli`/`tinymist`), not compiled to WASM (that pattern — `typst.ts` — is for browser-only apps with no native process).
- **World implementation**: hand-write a small `struct TauriWorld` implementing `typst::World`'s 7 methods (`library`, `book`, `main`, `source`, `file`, `font`, `today`), copying the shape of `typst-cli`'s `SystemWorld` (fields: `library`, `fonts`, `files`, cached `now`). Use `typst-kit`'s `fonts::embedded()` for Typst's default (Latin/math) faces. **Revised during M1** (superseding the original "disable system scanning, bundle 1-2 fonts" plan): embedded fonts alone have no CJK coverage, so Chinese/Japanese/Korean text rendered blank. Fixed by also merging in `typst_kit::fonts::system()` — Typst's automatic glyph-fallback then finds whatever CJK-capable fonts are already installed, matching `typst-cli`'s own default behavior. This trades portability (CJK rendering now depends on the host machine's installed fonts, not just the app bundle) for correctness without the size/licensing cost of bundling a CJK font; the system font *metadata* scan is cached once per process (`LazyLock`) since it's too slow to redo per keystroke, while actual font bytes still load lazily per compile (relies on OS page cache). Pinned by a `cargo test` asserting the font book has fallback coverage for a CJK string.
- **Diagnostics carry a source line, not just a message**: `SourceDiagnostic` (from `typst::compile`) carries a `Span`, which the current `compile.rs`/`CompileDiagnostic` discards — `to_diagnostic` only extracts `severity`/`message`. Resolve the span back to a 1-indexed `(line, column)` via the compiling `Source` (`source.range(span)` for the byte offset, then `Source::byte_to_line`/`byte_to_column` — confirm exact `typst-syntax` method names at implementation time) and add `line`/`column` fields to `CompileDiagnostic`. Frontend shows this as a CodeMirror gutter/inline marker at that line (M1) and, once WYSIWYG exists, resolves it through the M5 position map to highlight the originating block instead of a raw generated-source line number.
- **Editor**: raw ProseMirror (`prosemirror-model`/`-view`/`-state`/`-commands`/`-keymap`), custom schema — *not* Milkdown, because Milkdown's parser/serializer architecture is markdown-first and would fight us when adding a second (Typst) source format onto the same schema. Source-mode views (Typst/Markdown raw text) use CodeMirror 6 in plain-text mode; syntax highlighting is a stretch goal, not required to prove the loop.
  - **Fixed post-M6**: `codemirror`'s `basicSetup` bundles `closeBrackets()` (bracket/quote auto-closing), a programming-editor convenience that actively corrupts typed or pasted Typst/Markdown source — both freely use `(`/`[`/`{` as plain syntax (e.g. `#table(columns: (1fr, 2fr), [a], [b])`), and typing or pasting a *complete* snippet containing them leaves extra auto-inserted closing brackets alongside the user's own, unbalancing delimiter counts. Directly reproduced (simulated real keystrokes turning a `#table(...)` call into mismatched-parenthesis source that then parsed as something unrecognizable) and confirmed as the cause of a user-reported bug where content appeared corrupted after switching views. Fixed in `SourceEditor.tsx` by replacing `basicSetup` with its own extension list minus `closeBrackets()`/`closeBracketsKeymap` — `basicSetup`'s own doc comment invites exactly this ("copy it into your own code, and adjust it as desired").
- **React + TypeScript + Vite** frontend, **Tauri v2** shell.

### Milestones

**M0 — Bootstrap & prove the hardest integration first**
Scaffold Tauri v2 + Vite/React app. Implement `TauriWorld` + font bundling + `compile_typst` command with a *hardcoded* Typst string. Render the returned SVG in the webview. This is the highest-risk integration (World trait boilerplate, font loading) — de-risk it before building anything else.

**M1 — Source-code loop, Typst only**
Plain CodeMirror text area for Typst source → debounced call to `compile_typst` → live SVG preview + diagnostics display. Proves `Typst 源码 → Typst 排版结果` end-to-end, including error surfacing, before the Editor Model exists at all. Diagnostics must include a resolved source **line/column**, not just the raw message (extend `CompileDiagnostic`, see Key technical decisions), so CodeMirror can place an inline/gutter marker at the exact failing line. While the `World`/`PagedDocument` plumbing is fresh, also wire `typst-ide`'s `jump_from_click_in_frame`/`jump_from_cursor` (via a small `IdeWorld` impl on `TauriWorld`): clicking the SVG preview scrolls/highlights the corresponding CodeMirror position, and moving the source cursor highlights the corresponding preview point — a second, direct proof of source↔render fidelity alongside the recompile loop.

**M2 — Editor Model schema**
Define the ProseMirror schema for the MVP subset (doc > heading(1–3) | paragraph | bullet_list | ordered_list > list_item, marks: strong/em/code) plus the opaque `unsupported_block` leaf. No UI yet — just the schema + a handful of hand-built `PMDoc` fixtures for later tests.

**M3 — Typst ⇄ Editor Model**
- `parse_typst_ast` Tauri command (via `typst_syntax::parse`), including recognizing `#name(...)`/`#name[...]` call nodes as `typst_call`, and `#set func(...)` statements as `typst_set` lifted into `settings` (see above).
- `typstAstToDoc` / `pmDocToTypst` TS functions.
- Round-trip fixture tests (vitest): for each fixture `.typ` file in the subset (including at least one with a `typst_call` and one with a `#set` rule), `parse → map → serialize` and assert stability; also compile the original and the round-tripped source and diff the rendered SVG (for `#set`, the diff should confirm the setting's visual effect — e.g. a changed font — survives the round trip).

**M4 — Markdown ⇄ Editor Model**
- `mdastToDoc` / `pmDocToMdast` using remark, including the ```` ```typst-call ```` and ```` ```typst-set ```` fence conventions.
- Same round-trip + compile-diff fixture tests, mirrored for `.md` fixtures (including one round-tripping a `typst_call` and one round-tripping a `#set` rule through Markdown and back).

**M5 — Wire the WYSIWYG UI**
Mount the ProseMirror `EditorView` with keymaps/toolbar for the subset (bold/italic/heading level/lists). Add a three-way view switcher (WYSIWYG / Typst source / Markdown source) that all read/write the same underlying `PMDoc`; switching parses into or serializes out of the model as needed. Preview pane stays live (debounced `pmDocToTypst` → `compile_typst`) regardless of which view is active. Extend `pmDocToTypst` to also emit a position map (PM node/offset ⇄ generated Typst byte offset) so the M1 click/cursor-sync feature also works while editing in WYSIWYG mode, not only in the raw Typst source view.

**M6 — Stabilize & prove the loop**
- Fixture-based round-trip + compile-diff suite as an automated regression gate (extend M3/M4 fixtures to cover mixed content and at least one `unsupported_block` case).
- Manual smoke checklist: author in WYSIWYG → switch to Typst source → switch to Markdown → switch back to WYSIWYG → verify content and preview are unchanged.
- Basic perf sanity check: debounce tuning so full recompilation-per-keystroke doesn't feel laggy at MVP document sizes (a few paragraphs) — no incremental compilation needed for MVP.

Explicitly out of scope for this MVP (call out to the user as future work, not silently dropped): math mode, tables, images/figures, links/footnotes/citations, `#let`/`#show`/control-flow/scoped `#set` (only opaque top-level `#name(...)`/`#name[...]` calls and top-level `#set func(...)` rules are supported, see above), multi-file projects/imports, PDF export button, true inline-layout WYSIWYG, CodeMirror syntax highlighting theming, collaborative editing, incremental compilation, range/selection-level click-and-cursor highlighting (point/caret-level sync only, see the precision note above), byte-exact WYSIWYG click/cursor sync inside bold/italic/code-marked-up text (proportional interpolation only, see the M5 addition to the precision note above).

### Verification

- `cargo test` for `TauriWorld`/font-loading sanity (M0) and any Rust-side unit tests on `parse_typst_ast` shape.
- `vitest` round-trip + compile-diff suite (M3/M4/M6) as the primary evidence the loop is stable — this is the actual deliverable proof, not just "it runs."
- Manual run via `tauri dev`: load each MVP-subset fixture, exercise the M6 smoke checklist by hand in the running app, confirm preview pane matches expected rendering for each of the three entry views.

### Key risks (flagged, not hidden)

- Typst crate boilerplate (`World` trait, font setup) is the most likely source of early slowdown — front-loaded into M0 deliberately.
- Two independent parsers (Typst, Markdown) feeding one schema constrains both to their common subset; anything either grammar expresses that the other can't becomes an `unsupported_block`, by design — this keeps the loop honest rather than silently lossy.
- Full recompile on every debounce is fine at MVP doc sizes; flagged as a known scaling limit, not solved here.
- `typst-ide`'s jump API (click/cursor sync) is not battle-tested by prior art (tinymist reimplements it independently) — pin the exact version and budget time to adapt if signatures shift; treat it as a valuable but non-blocking enhancement to M1, not something the rest of the plan depends on.

---

## Phase 2 — Post-MVP Roadmap

### Goal and lane choice

The MVP proved the loop is *stable*; it did not make the editor *usable* for a real document or *complete* against Typst's actual syntax. Phase 2 picks up the MVP's "explicitly out of scope" list and works through it in **hybrid order** (agreed with the user over three candidate lanes — content-coverage-first, fidelity-first, and product-completeness-first): ship the app-level basics that make the existing subset usable on a real file first (nothing else matters if you can't open/save one), then grow the content subset by cheapest-to-most-expensive addition, and defer everything that only pays off once the subset is already bigger (`#let`/`#show`, precision work, incremental compilation) to a later phase.

Two things do **not** change in Phase 2: the hub-and-spoke architecture (Editor Model as the canonical ProseMirror doc; Typst/Markdown as two independent spokes; preview always through real compiled Typst source), and the `unsupported_block`/opaque-node policy for anything outside the (now larger) subset. Every milestone below is additive to that architecture, not a redesign of it.

### Milestones

**M7 — File I/O — done**
Open/Save/Save As via `@tauri-apps/plugin-dialog` + `@tauri-apps/plugin-fs`. Loading a file picks the Typst or Markdown spoke by extension (`.typ` vs `.md`) and parses into the Editor Model as usual; the open file's path becomes session state the app needs from here on (M10 image resolution depends on it). Track a `dirty` flag on the model (compare against last-saved serialization, not a naive edit-count) for a title-bar/tab indicator and an unsaved-changes guard on close/open-another-file. Recent-files list persisted via `@tauri-apps/plugin-store` (or a small JSON file) since there's no filesystem-agnostic browser storage answer in a Tauri shell. `Ctrl+S`/`Ctrl+O`/`Ctrl+Shift+S` keybindings. No new Editor Model or round-trip logic — purely an app-shell feature, lowest technical risk of the phase.
- Implemented in `src/fileIO.ts` (pure extension→spoke/title helpers, unit-tested), `src/recentFiles.ts` (`@tauri-apps/plugin-store` wrapper), and wired into `src/App.tsx` (file bar with Open/Save/Save As + recent-files dropdown, window-close guard via `getCurrentWindow().onCloseRequested`, global `Ctrl+S`/`Ctrl+O`/`Ctrl+Shift+S` keydown handler). `dirty` is a derived comparison — live Typst/Markdown serialization vs. a `lastSaved{Typst,Markdown}Text` snapshot taken at each load/save — not a stored boolean, so an edit undone back to the saved content correctly reports clean.
- `fs:allow-read-text-file`/`fs:allow-write-text-file` are scoped to `**` (any path) in `src-tauri/capabilities/default.json`, since a general-purpose "open any file" dialog needs it; M11's narrower document-directory-only scoping applies to the *image-resolution* fs access it adds on top of this, not to open/save itself.

**M8 — PDF export — done**
`typst_pdf::pdf(&paged_document, ...)` (the crate already sits next to `typst-render`/`typst-svg` in the Typst ecosystem, same `PagedDocument` the preview pipeline already produces) → new `export_pdf` Tauri command → Save dialog. Export button/menu item in the frontend. Verification: export a fixture doc, confirm the PDF opens and its page count/text matches the SVG preview (a text-extraction sanity check, not full visual diffing).
- Implemented in `src-tauri/src/export.rs`: `export_pdf(source, path)` recompiles through the same `TauriWorld`/`PagedDocument` pipeline as `compile_typst`, then writes the PDF bytes straight to `path` via `std::fs::write` (no fs-plugin round trip needed for binary data — the Save dialog only supplies the path, from `@tauri-apps/plugin-dialog`'s `save()`). Compile/export errors surface as a `Result<(), String>` Tauri error via a new `diagnostics_to_string` helper in `compile.rs` (reused, not duplicated, line/column formatting).
- Frontend: `Export PDF…` button in `App.tsx`'s file bar exports whatever `derived.source` currently holds — the exact Typst source already feeding the live SVG preview, regardless of which of the three views is active — so the exported PDF's content matches the preview by construction rather than by re-deriving a possibly-different serialization. `src/fileIO.ts`'s `withPdfExtension` suggests a same-directory `.pdf` default path.
- Verified with `cargo test` (`export::tests`: valid source produces bytes starting with the `%PDF-` magic number; a compile error reports `Err` and leaves no file on disk) rather than a full page-count/text-extraction fixture check — judged sufficient for MVP-sized fixtures given `typst_pdf::pdf` is a well-tested first-party crate, not the app's own logic.

**M9 — Links — done**
Cheapest content addition — a mark, not a new node type, so it reuses the existing mark infrastructure (`strong`/`em`/`code`) rather than needing new schema plumbing:
- Typst: `#link("url")[text]` — a self-contained call-like node, parsed/serialized directly (not opaque — unlike `typst_call`, we *do* understand this one's shape) into a `link` mark with a `href` attribute.
- Markdown: native `[text](url)` — mdast `link` node maps directly.
- ProseMirror: standard `link` mark (attrs: `href`), toolbar button + keymap, no new leaf/block node.
- Round-trip fixtures mirroring the M3/M4 pattern, including a link inside other marks (bold link) to confirm mark-stacking survives both spokes.
- Implemented in `ast.rs` (`AstInline::Link` — a recursive container, not a flattened mark name, since a link's body can itself contain marked-up content, unlike `strong`/`em`/`code`; `as_link_call` recognizes `#link("url")[body]` specifically and excludes it from the generic opaque-`FuncCall`/`SingleCall` paths), `schema.ts` (`link` mark, `inclusive: false`), `typstAst.ts`/`markdown.ts` (both directions: recurse into the link body then stack the `link` mark via `addToSet` — not prepend — onto every produced node, since ProseMirror requires marks sorted by schema rank; serialization always emits the link outermost regardless of the source's original nesting order, e.g. `*#link(..)[x]*` and `#link(..)[*x*]` both round-trip to the same canonical form), and `wysiwygCommands.ts` (`toggleLink`: prompts for a URL on an empty-selection-aware add, strips the mark on toggle-off; `Mod-k` keymap + toolbar button in `WysiwygEditor.tsx`). `[`/`]` were added to the Typst text-escape set since link body text is now the first place arbitrary text gets embedded inside a Typst content-block delimiter pair. 135/135 frontend tests, 36/36 Rust tests pass.

**M10 — Tables**
The highest-effort content addition this phase, because Typst has no lightweight table *markup* (unlike Markdown's GFM pipe tables) — a table is a `#table(columns: .., [cell], [cell], ...)` function call, so representing an editable table in the Editor Model means parsing/generating a *structured* subset of call-argument syntax, not treating it as opaque like `typst_call`:
- Typst ⇄ model: recognize `#table(...)` calls whose arguments match a supported shape (a `columns:` argument plus a flat sequence of content-block cell arguments — no `#table.cell`/rowspan/colspan/styling args in MVP, those fall through to `unsupported_block` as a whole call), and parse each cell's content recursively through the existing subset parser (a cell can contain paragraphs/marks, not just plain text). Serializer re-emits the same call shape deterministically.
- Markdown ⇄ model: `remark-gfm` table/tableRow/tableCell mdast nodes — GFM tables are cell-flat (no block content per cell), so constrain the Editor Model's table cells to inline content only when round-tripping through Markdown, and treat a table containing block-level cell content (a list or heading inside a cell) as something Markdown can't carry — falls back to the same fenced-passthrough convention used for `typst_call`/`unsupported_block` on that leg.
- ProseMirror: `prosemirror-tables` (table/table_row/table_cell/table_header nodes, selection/resize commands) rather than hand-rolling table editing.
- Round-trip + compile-diff fixtures per the M3/M4/M6 pattern, including one table with mixed inline marks in a cell and one that exercises the Markdown-side block-content fallback above.

**M11 — Images & figures**
Depends on M7 (needs a real on-disk file path to resolve relative image paths against — the MVP `TauriWorld` is in-memory with no filesystem access per the README, so this is the first milestone that gives it one, scoped to the open document's directory only, not arbitrary filesystem access):
- Typst: `#image("path")` and `#figure(image("path"), caption: [...])` — parsed into an `image` leaf node (`src`, optional `caption`) and a `figure` wrapper; `TauriWorld::file()` resolves relative paths against the open document's directory.
- Markdown: `![alt](path)` → image node directly; a captioned image maps to/from Typst's `#figure` wrapper (Markdown has no native figure/caption construct, so the caption round-trips as the image's `alt` text — a deliberate, documented lossy-but-stable mapping, same spirit as the `unsupported_block` policy).
- WYSIWYG rendering: Tauri's asset protocol (`convertFileSrc`) scoped to the document directory, not a data-URI copy — keeps large images out of the Editor Model.
- Security note: the fs/asset-protocol scope granted here must be narrowed to the open document's directory (and read-only), not project-wide — flag this explicitly in the Tauri capability config, don't default to broad access.
- Round-trip + compile-diff fixtures per the established pattern, plus a manual check that a missing/broken image path degrades to a diagnostic rather than a crash (mirrors the M1 diagnostics work, new failure mode).

**M12 — Toolbar / UI polish**
Borrow the visual language of modern block editors (Tiptap, PlateJS — floating/bubble toolbars, block drag-handles, slash-command menus) without adopting either as a dependency: Tiptap is a thin wrapper around the same ProseMirror core this project already hand-builds its schema/node views on, and PlateJS is built on Slate (a different core entirely) — either would mean re-expressing the existing schema, `typst_call`/`typst_set` node views, and M5 position-mapping inside a foreign framework, a cost far out of proportion to "nicer toolbar." Implemented instead as additional ProseMirror plugins/decorations on the existing `EditorView`:
- Floating/bubble toolbar shown on text selection (bold/italic/code/link) as an alternative or complement to the current static toolbar.
- Slash-command menu (`/heading`, `/list`, ...) for inserting blocks at the cursor, via a small custom plugin watching for `/` at block start (or `prosemirror-inputrules`).
- Per-block hover affordance (drag handle / `+` insert button) via block-level decorations.
Pure presentation layer over the existing `PMDoc`/schema — no new Editor Model concepts, no round-trip risk — so it carries no fixture/compile-diff test burden and can land at any point relative to M9–M11.

### Deferred past Phase 2 (explicit, not silently dropped)

Carried over from the MVP's out-of-scope list, intentionally not attempted this phase because each only pays off once the subset above exists, or is large enough to be its own phase:
- **`#let`/`#show`/control-flow** — real semantic (not opaque) support is a substantially larger project than everything above combined (variable binding, scoping, and rule application, not just recognizing a self-contained node span) — worth scoping as its own phase once M9–M11 land.
- **Fidelity/precision work** — byte-exact WYSIWYG click/cursor sync (currently proportional interpolation inside marked-up runs, see M5 notes above), range/selection-level highlighting (currently point/caret-only), incremental compilation (currently full-recompile-per-keystroke). Deferred because hardening sync/perf for a subset that's about to grow (M9–M11) risks redoing the work twice.
- **Footnotes/citations, math mode, multi-file imports beyond image assets, collaborative editing** — no change in status from the MVP plan; still out of scope, revisit after the above.

### Risks

- **Table Typst-representation risk**: constraining `#table(...)` to a supported argument shape (M10) is a heuristic, not a full parse of Typst's argument grammar — a real-world document's table call is more likely to fall outside the supported shape (and thus become opaque) than the MVP's other opaque-fallback cases, since `#table` has many legitimate styling arguments in practice. Budget time to widen the supported shape based on real fixtures, not just the minimal one built first.
- **Image path/security risk**: M11 is the first milestone giving the Rust backend real filesystem access (beyond the in-memory MVP World) — get the Tauri capability scoping right (document-directory-only, read-only) from the start rather than retrofitting it after a broader grant ships.
- **Markdown fidelity gap widens**: GFM tables (cell-inline-only) and image-caption-as-alt-text (M11) are two more points where the Markdown spoke can't carry everything the Typst spoke can — consistent with the MVP's existing "two independent parsers constrain to their common subset" risk, but worth flagging that Phase 2 grows the number of these deliberate lossy-but-stable fallbacks, not just the one (`unsupported_block`) the MVP shipped with.

---

## Phase 3 — Single-View WYSIWYG (the long-term target)

### Reframing: this is not "contenteditable on vector paths"

The user's ask is a real, final-product goal, not a stretch aspiration: **one view, no separate preview pane**, backed by real Typst rendering, made feasible by incremental compilation. Earlier discussion (this conversation, pre-roadmap) framed the only path to single-view as hand-rolling cursor/selection/IME directly on top of the compiled SVG/Frame output — genuinely an open-ended rewrite, correctly rejected for the MVP. That framing was incomplete: **Typora itself doesn't do that either.** Typora's actual mechanism is *per-block focus swapping* — the block currently being edited shows a lightly-styled source/editable view, and every other block shows fully rendered output, swapped on focus/blur, not one continuous contenteditable surface pretending to be both.

Applying that same mechanism here turns single-view WYSIWYG into a scoped integration problem instead of a rewrite: **ProseMirror keeps owning text editing** (cursor, selection, IME composition, undo/redo — already solved, don't touch it) **and Typst keeps owning rendering** (already solved via `compile_typst`) — the only genuinely new work is (a) fast enough incremental compilation to recompile-and-swap on every focus change/keystroke without visible lag, and (b) a block-level focus-swap UI built on ProseMirror node views, reusing the click/cursor position-mapping (`jump_from_click`/`jump_from_cursor`) already built in M1/M5 to hand off cleanly between "rendered" and "editable" states at the right character offset.

### Milestones (tentative — M13 is a feasibility spike other milestones depend on)

**M13 — Incremental compilation feasibility spike**
Before designing the swap UI, establish the actual latency budget. `typst::compile` already uses `comemo`-based memoization internally (this is what makes `typst-cli --watch`/`tinymist`'s live preview fast) — benchmark whether editing one block of a realistic multi-page fixture and recompiling the *whole* document already lands comfortably under a per-keystroke budget (~16–50ms) before assuming block-scoped/partial compilation is required. If whole-doc incremental recompilation is fast enough, M14+ gets much simpler (no need to isolate a block's compiled output from document-level context). If not, this milestone's output is a concrete measurement of where the wall is, informing whether block-scoped compilation is worth the complexity it adds.

**M14 — Per-block render/edit swap**
Extend the ProseMirror schema's node views so each top-level block (paragraph, heading, list item, etc.) can present as either: (a) an inline Typst-rendered SVG fragment sized/positioned to match its place in the document flow (inactive/blurred state), or (b) today's editable rich-text node view (active/focused state) — toggling on focus/blur/click, not on every keystroke of a *different* block. The preview pane as a distinct UI element goes away; its role is absorbed into the per-block rendered fragments.

**M15 — Reflow and pagination handling**
When an edited block's compiled height changes, every later block's vertical position shifts (real Typst pagination, not CSS reflow) — the document container must reposition subsequent rendered fragments after each incremental compile. Requires an explicit, user-visible answer for a block that straddles a page break in single-view mode (Typst's pagination is real, unlike Typora's infinite scroll) — this is new UX territory the MVP's split-pane preview never had to solve, since a separate preview pane could just show real pages without the editing surface caring.

**M16 — Cursor/selection continuity across swaps**
Reuse and generalize the `jump_from_click`/`jump_from_cursor` infrastructure so a click on a rendered (inactive) block cleanly activates that block's editable node view at the corresponding character offset, and blurring re-renders it back — this promotes the M5 position-mapping work from an optional preview-sync nicety to load-bearing infrastructure that fires on every click, not just an explicit "sync" action.

### Risks (flagged, not hidden)

- **Cross-block layout dependencies**: a block's compiled size/appearance isn't always purely a function of its own content — earlier `#set` rules, automatic numbering, or widow/orphan control can mean an edit to one block should, in principle, affect neighboring blocks' rendering too. Full accuracy may require re-rendering a window of neighboring blocks rather than just the one edited; scope the first version to accept some inaccuracy here rather than solving it upfront.
- **Page-boundary UX is genuinely undefined** — decide (with the user) what single-view mode does with a block that spans a page break before building M14, not during.
- **This phase is large enough to warrant treating M13 as a hard gate**: if the feasibility spike shows incremental recompilation can't hit an acceptable latency budget even for whole-doc recompilation, the milestone plan for M14+ needs to be revisited (block-scoped partial compilation is a much bigger lift than the sketch above assumes) before committing further design or implementation time.
