# Typst WYSIWYG Editor — MVP Plan

## Context

Goal: prove that `源码 ⇄ 编辑模型 ⇄ Typst 排版结果` can form a **stable closed loop**, on top of Tauri. This is not "build a Typst IDE" — it's a narrow proof that:

- a shared **Editor Model** (rich-text document, not raw text) can be losslessly parsed from *and* serialized back to **Typst source**, and separately to/from **Markdown source**, for a small syntax subset;
- that same Editor Model can always be serialized to Typst source and handed to the **real Typst compiler** (not a reimplementation) to produce an accurate rendered preview;
- switching between WYSIWYG editing / Typst source view / Markdown source view does not corrupt or drift content, proven by automated round-trip tests plus a manual smoke check.

Two scope decisions already made with the user (do not revisit without asking):
1. **WYSIWYG = rich-text editing surface + a separate accurate preview pane** (Typora/Notion-style), *not* true inline editing on top of Typst's real paginated layout. The latter is architecturally an order of magnitude harder and out of scope for an MVP.
2. **Markdown is a first-class second source format**, requiring real Markdown ⇄ Editor Model conversion (not just a UX inspiration) — Typst source and Markdown source are two independent "spokes" around the same Editor Model "hub."

**Status: M0 and M1 (Rust side) are already implemented** in `src-tauri/src/` — `typst_world.rs` (`TauriWorld`), `compile.rs` (`compile_typst` command), `jump.rs` (`jump_from_click`/`jump_from_cursor` commands), wired in `lib.rs`. The rest of this plan (Editor Model, Markdown support, WYSIWYG UI, and the `typst_call`/`typst_set` extensions below) is not yet built.

## Architecture

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

### Process split (Rust backend vs. TypeScript frontend)

Rust backend (Tauri commands) owns everything that must use the **real Typst engine**, so fidelity is never in question:
- `parse_typst_ast(source: String) -> AstJson` — via `typst_syntax::parse` (pure, infallible, no World needed), pruned/simplified to a JSON shape covering only the MVP node kinds (everything else becomes an opaque span).
- `compile_typst(source: String) -> CompileResult` — builds a `World`, runs `typst::compile::<PagedDocument>`, renders via `typst_render::render_merged` (PNG) or `typst_svg::svg_merged` (SVG, preferred — inline into DOM, scales cleanly), returns image bytes + `SourceDiagnostic`s (for error surfacing) over IPC.

TypeScript frontend owns the Editor Model and both source-format conversions, since ProseMirror already lives there and Markdown parsing has mature TS-typed libraries (`@types/mdast`, remark's own types) — no need to cross the IPC boundary for every keystroke:
- `typstAstToDoc(ast) -> PMDoc` / `pmDocToTypst(doc) -> string` — mapper + hand-written serializer for the constrained subset (deterministic, no need for a full Typst pretty-printer).
- `mdastToDoc(ast) -> PMDoc` / `pmDocToMdast(doc) -> mdast` using `remark-parse`/`remark-stringify` (well-maintained CommonMark libs) — reuses the *same* PMDoc schema/subset as the Typst path.
- ProseMirror schema, keymaps, and the WYSIWYG `EditorView`.

### Key technical decisions (from research, see below)

- **Typst crates** (all pinned `= "0.15"`, current stable `0.15.1`): `typst`, `typst-syntax`, `typst-layout` (needed directly — `PagedDocument`/`Page` are not re-exported through the `typst` facade), `typst-kit` (font/file/date helpers, feature-gated), `typst-render` and/or `typst-svg`, `typst-ide` (click/cursor position mapping, see below).
- **Bidirectional position mapping via `typst-ide`**: `typst-ide::jump_from_click_in_frame(world, doc, frame, click_point) -> Option<Jump>` (click on a rendered page → `Jump::File(id, byte_offset)`) and `typst-ide::jump_from_cursor(doc, source, cursor_byte_offset) -> Vec<PagedPosition>` (source cursor → page + point to scroll/highlight) give us a *direct*, library-backed link between Typst source and the rendered preview, on top of the debounced full-recompile loop. Requires implementing the small `IdeWorld` trait (extends `World` with `upcast()`) on top of `TauriWorld`. This is a concrete, testable manifestation of "source ↔ 排版结果" and is cheap to add once `compile_typst`'s `World`/`PagedDocument` exist (M1) — do it there rather than deferring it.
  - **Risk, flag explicitly**: `typst-ide` is a normal first-party crate (not marked experimental) but pre-1.0 and versioned in lockstep with core `typst`; notably, `tinymist` (the most mature real-world Typst-as-a-library consumer) does **not** depend on `typst-ide` for this and instead hand-rolls an equivalent, less-complete `jump_from_click`/`jump_from_cursor` in `tinymist-query`. Treat `typst-ide`'s API as usable and reasonably tested (it has its own test suite) but not production-validated by prior art — pin the version tightly and expect to revisit signatures on any `typst` upgrade.
  - **Precision note**: the precision of click/cursor sync comes entirely from these Rust-side functions operating on the compiled `Frame`/`Point` data — not from the preview's output format. SVG (the chosen format) is resolution-independent (pt↔pixel ratio comes for free from its `viewBox`, no re-render on zoom) and just as easy to overlay a highlight/caret on (inject a sibling `<rect>`/`<line>` into the inline SVG DOM) as a canvas would be — canvas was considered and rejected: it would add DPI/zoom-tracking and re-render-per-zoom costs for no precision gain, since neither format carries queryable per-glyph source-span metadata (Typst renders glyphs as filled paths either way). `jump_from_cursor` currently returns a single `Point` (good for an exact caret); highlighting a whole word/range as a filled box would need separate future Rust-side work (bounding-box extraction from the `Frame`) regardless of output format.
  - **Extended to WYSIWYG in M5**: `pmDocToTypstWithPositions` (src/typstAst.ts) records a PM-position ⇄ Typst-byte-offset range per inline leaf (text run/hard_break/typst_call) and interpolates proportionally within the containing range for both lookup directions, so a click landing mid-run lands the WYSIWYG cursor near that point rather than snapping to the run's start. Still an approximation *inside* a marked-up run specifically: Typst's `*`/`_`/`` ` `` wrapper characters (and text escaping) make the Typst byte length of a run diverge from its PM character length, so the interpolation is proportionally close but not byte-exact there. Accepted as an MVP limitation, not fixed — see the "Explicitly out of scope" list.
- **No WASM.** Tauri already gives a native Rust backend; embed Typst natively there (same pattern as `typst-cli`/`tinymist`), not compiled to WASM (that pattern — `typst.ts` — is for browser-only apps with no native process).
- **World implementation**: hand-write a small `struct TauriWorld` implementing `typst::World`'s 7 methods (`library`, `book`, `main`, `source`, `file`, `font`, `today`), copying the shape of `typst-cli`'s `SystemWorld` (fields: `library`, `fonts`, `files`, cached `now`). Use `typst-kit`'s `fonts::embedded()` for Typst's default (Latin/math) faces. **Revised during M1** (superseding the original "disable system scanning, bundle 1-2 fonts" plan): embedded fonts alone have no CJK coverage, so Chinese/Japanese/Korean text rendered blank. Fixed by also merging in `typst_kit::fonts::system()` — Typst's automatic glyph-fallback then finds whatever CJK-capable fonts are already installed, matching `typst-cli`'s own default behavior. This trades portability (CJK rendering now depends on the host machine's installed fonts, not just the app bundle) for correctness without the size/licensing cost of bundling a CJK font; the system font *metadata* scan is cached once per process (`LazyLock`) since it's too slow to redo per keystroke, while actual font bytes still load lazily per compile (relies on OS page cache). Pinned by a `cargo test` asserting the font book has fallback coverage for a CJK string.
- **Diagnostics carry a source line, not just a message**: `SourceDiagnostic` (from `typst::compile`) carries a `Span`, which the current `compile.rs`/`CompileDiagnostic` discards — `to_diagnostic` only extracts `severity`/`message`. Resolve the span back to a 1-indexed `(line, column)` via the compiling `Source` (`source.range(span)` for the byte offset, then `Source::byte_to_line`/`byte_to_column` — confirm exact `typst-syntax` method names at implementation time) and add `line`/`column` fields to `CompileDiagnostic`. Frontend shows this as a CodeMirror gutter/inline marker at that line (M1) and, once WYSIWYG exists, resolves it through the M5 position map to highlight the originating block instead of a raw generated-source line number.
- **Editor**: raw ProseMirror (`prosemirror-model`/`-view`/`-state`/`-commands`/`-keymap`), custom schema — *not* Milkdown, because Milkdown's parser/serializer architecture is markdown-first and would fight us when adding a second (Typst) source format onto the same schema. Source-mode views (Typst/Markdown raw text) use CodeMirror 6 in plain-text mode; syntax highlighting is a stretch goal, not required to prove the loop.
- **React + TypeScript + Vite** frontend, **Tauri v2** shell.

## Milestones

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

## Verification

- `cargo test` for `TauriWorld`/font-loading sanity (M0) and any Rust-side unit tests on `parse_typst_ast` shape.
- `vitest` round-trip + compile-diff suite (M3/M4/M6) as the primary evidence the loop is stable — this is the actual deliverable proof, not just "it runs."
- Manual run via `tauri dev`: load each MVP-subset fixture, exercise the M6 smoke checklist by hand in the running app, confirm preview pane matches expected rendering for each of the three entry views.

## Key risks (flagged, not hidden)

- Typst crate boilerplate (`World` trait, font setup) is the most likely source of early slowdown — front-loaded into M0 deliberately.
- Two independent parsers (Typst, Markdown) feeding one schema constrains both to their common subset; anything either grammar expresses that the other can't becomes an `unsupported_block`, by design — this keeps the loop honest rather than silently lossy.
- Full recompile on every debounce is fine at MVP doc sizes; flagged as a known scaling limit, not solved here.
- `typst-ide`'s jump API (click/cursor sync) is not battle-tested by prior art (tinymist reimplements it independently) — pin the exact version and budget time to adapt if signatures shift; treat it as a valuable but non-blocking enhancement to M1, not something the rest of the plan depends on.
