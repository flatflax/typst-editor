# Phase 1 — MVP (M0–M6, complete)

Architecture reference: [architecture.md](architecture.md). Design rules: [design-principles.md](design-principles.md).

## Goal

Prove that `Source ⇄ Editor Model → Typst Compiler → Layout/Render` forms a **stable
closed loop** on top of Tauri, before attempting single-view editing. Not "build a
Typst IDE" — a proof that:

- a shared **Editor Model** (rich-text document) can be losslessly parsed from and
  serialized back to **Typst source**, and separately to/from **Markdown source**, for
  a small syntax subset;
- that Editor Model always serializes to Typst source and compiles via the real Typst
  compiler for an accurate rendered preview;
- switching between WYSIWYG / Typst source / Markdown source doesn't corrupt or drift
  content — proven by round-trip tests plus a manual smoke check.

**Scope subset** (expressible identically in Typst markup, Markdown, and the
ProseMirror schema): paragraphs, headings (levels 1–3), bold, italic, inline code,
bullet/ordered lists, hard line breaks, plus opaque `#` function-call and top-level
`#set` rule support (below). Excluded: math, tables, images/figures, links, footnotes,
citations, raw blocks, multi-file imports, PDF export. [Phase 2](phase2-content-io.md)
later added tables, images/figures, links, file I/O, and PDF export; math, footnotes/
citations, raw blocks, and multi-file imports remain deferred (see
[Deferred past Phase 2](phase2-content-io.md#deferred-past-phase-2)).

**Unsupported input policy**: source outside the subset is wrapped as an opaque
`unsupported_block` leaf that round-trips its raw text verbatim but isn't
WYSIWYG-editable — keeps the loop stable (no crashes, no silent data loss) without
requiring full-language support.

## Opaque call/set support

- **`#` function calls** (`typst_call`): a distinct node type storing
  `{ name, raw }`, where `raw` is the exact source slice, never re-parsed. Typst
  serializer re-emits `raw` verbatim. Markdown has no equivalent, so it round-trips as
  a fenced ```` ```typst-call ```` block. WYSIWYG renders it as an inert, non-editable
  chip. No `#let`/`#show`/control-flow support — those still fall to
  `unsupported_block`.
- **`#set` rules** (`typst_set`): same verbatim-round-trip approach, but stored in a
  separate top-level `settings: TypstSet[]` list (not interleaved in flow content),
  each `{ function, raw }`. Serializer emits all `settings` at the top of generated
  Typst source. Markdown uses the same fence convention, tagged ```` ```typst-set ````.
  WYSIWYG exposes a "Document Settings" drawer (non-editable chips) — the WYSIWYG
  surface never simulates `#set`'s visual effect; only the compiled preview does. Only
  one `#set` per fence/position — scoped `#set` falls to `unsupported_block`.

## Milestones

**M0 — Bootstrap.** Tauri v2 + Vite/React scaffold. `TauriWorld` + font bundling +
`compile_typst` with a hardcoded string, SVG rendered in the webview. De-risks the
World-trait/font-loading integration before anything else is built.

**M1 — Source-code loop, Typst only.** CodeMirror text area → debounced
`compile_typst` → live SVG preview + diagnostics with resolved line/column. Wires
`typst-ide`'s `jump_from_click_in_frame`/`jump_from_cursor` via `IdeWorld` on
`TauriWorld`: clicking the preview scrolls/highlights the source position and vice
versa.

**M2 — Editor Model schema.** ProseMirror schema for the subset (`doc > heading(1–3) |
paragraph | bullet_list | ordered_list > list_item`, marks `strong`/`em`/`code`) plus
`unsupported_block`. Schema only, plus hand-built `PMDoc` fixtures.

**M3 — Typst ⇄ Editor Model.** `parse_typst_ast` (via `typst_syntax::parse`,
recognizing `typst_call`/`typst_set`), `typstAstToDoc`/`pmDocToTypst`. Round-trip
fixture tests (vitest): parse → map → serialize stability, plus compiling
original-vs-round-tripped source and diffing the rendered SVG.

**M4 — Markdown ⇄ Editor Model.** `mdastToDoc`/`pmDocToMdast` via remark, including
the `typst-call`/`typst-set` fence conventions. Same round-trip + compile-diff tests
mirrored for `.md` fixtures.

**M5 — Wire the WYSIWYG UI.** ProseMirror `EditorView` with keymaps/toolbar for the
subset. Three-way view switcher (WYSIWYG / Typst source / Markdown source) over one
`PMDoc`. Preview stays live regardless of active view. `pmDocToTypst` extended to emit
a PM-position ⇄ Typst-byte-offset map so click/cursor sync also works in WYSIWYG mode.

**M6 — Stabilize & prove the loop.** Fixture-based round-trip + compile-diff suite as
an automated regression gate, extended to mixed content and `unsupported_block`.
Manual smoke checklist: WYSIWYG → Typst source → Markdown → WYSIWYG, content/preview
unchanged. Debounce tuning so full recompile-per-keystroke stays responsive at MVP doc
sizes (no incremental compilation needed yet).

**Explicitly out of scope**: math, tables, images/figures, links/footnotes/citations,
`#let`/`#show`/control-flow/scoped `#set`, multi-file imports, PDF export, true
inline-layout WYSIWYG, CodeMirror syntax highlighting, collaborative editing,
incremental compilation, range-level click/cursor highlighting (point-only), byte-exact
WYSIWYG sync inside marked-up text (proportional interpolation only).

## Verification

- `cargo test` for `TauriWorld`/font-loading sanity and `parse_typst_ast` shape.
- `vitest` round-trip + compile-diff suite — the primary evidence the loop is stable.
- Manual `tauri dev` run: load each fixture, exercise the M6 smoke checklist, confirm
  preview matches expected rendering from all three entry views.

## Risks

- Typst crate boilerplate (`World` trait, font setup) was the likely early bottleneck —
  front-loaded into M0.
- Two independent parsers (Typst, Markdown) feeding one schema constrains both to their
  common subset; anything either grammar expresses that the other can't becomes
  `unsupported_block`, by design.
- Full recompile per debounce is fine at MVP doc sizes; a known scaling limit, not
  solved here.
- `typst-ide`'s jump API isn't battle-tested by prior art (tinymist reimplements it
  independently) — pin the exact version, budget time to adapt if signatures shift;
  treated as a non-blocking enhancement to M1.
