# Phase 2 — Content & File I/O (complete, M7–M12)

Architecture reference: [architecture.md](architecture.md). Design rules: [design-principles.md](design-principles.md).

## Goal

The MVP proved the loop was stable, not that the editor was usable or complete against
Typst's real syntax. Phase 2 works through the MVP's "out of scope" list in hybrid
order: ship app-level basics that make the existing subset usable on a real file first,
then grow the content subset cheapest-to-most-expensive, deferring anything that only
pays off once the subset is bigger (`#let`/`#show`, precision work, incremental
compilation) to later work — see [Deferred past Phase 2](#deferred-past-phase-2) below.

Unchanged from Phase 1: the hub-and-spoke architecture, the `unsupported_block`/opaque
policy for anything outside the subset, and the **primitives over nodes** principle.
Every milestone here is additive, not a redesign.

## Milestones

**M7 — File I/O.** Open/Save/Save As via `@tauri-apps/plugin-dialog` +
`@tauri-apps/plugin-fs`. Extension (`.typ` vs `.md`) selects the parse spoke. `dirty`
flag is a derived comparison (live serialization vs. last-saved snapshot), not an
edit-count boolean. Recent-files list via `@tauri-apps/plugin-store`.
`Ctrl+S`/`Ctrl+O`/`Ctrl+Shift+S` keybindings. `fs:allow-read/write-text-file` scoped to
`**` in `src-tauri/capabilities/default.json` (open-any-file needs it; M11 narrows
scope for image resolution specifically).

**M8 — PDF export.** `typst_pdf::pdf(&paged_document, ...)` via a new `export_pdf`
command, reusing the same `TauriWorld`/`PagedDocument` pipeline as `compile_typst`;
writes bytes straight to disk. Exports whatever `derived.source` currently holds, so
the PDF matches the live preview by construction. Verified via `cargo test` (valid
source produces `%PDF-`-prefixed bytes; a compile error returns `Err` and writes no
file) rather than full text-extraction diffing.

**M9 — Links.** Cheapest content addition — a mark, not a new node type.
`#link("url")[text]` parses/serializes directly (understood, not opaque) into a `link`
mark (`href` attr); Markdown's native `[text](url)` maps directly. Standard PM `link`
mark, toolbar button + `Mod-k` keymap. `AstInline::Link` is a recursive container (a
link body can itself contain marked-up content), stacked via `addToSet` so mark order
is canonical regardless of source nesting. `[`/`]` added to the Typst text-escape set.

**M10 — Tables.** Highest-effort addition — Typst has no lightweight table markup, only
`#table(columns: .., [cell], ...)`, so this parses a structured subset of
call-argument syntax rather than treating it as opaque. Supported shape: a `columns:`
arg + flat content-block cells (no `#table.cell`/rowspan/colspan/styling — those fall to
`unsupported_block` as a whole call); cell content recurses through the same
block/inline serializer as top-level content. Markdown side uses `remark-gfm` tables
(cell-inline-only per GFM); a table with block-level cell content falls back to the
same fenced-passthrough convention as `unsupported_block`. WYSIWYG via
`prosemirror-tables`. `columnsRaw` is only re-emitted verbatim when it still matches
the table's actual column count, else falls back to a plain integer, so a WYSIWYG
column edit can't emit a stale spec.

**M11 — Images & figures.** Depends on M7 for a real on-disk path to resolve relative
image paths against. `#image("path")` / `#figure(image("path"), caption: [...])` parse
into an `image` leaf (`src`, optional plain-text-only `caption`) and a `figure`
wrapper; Markdown's `![alt](path)` maps directly, with a captioned image's caption
round-tripping through `alt` text (a deliberate, documented lossy-but-stable mapping).
**Deviates from the original "Tauri asset protocol" plan**: the asset protocol's access
scope is static config, but this app has no fixed project root (a document can open
from anywhere), so the WYSIWYG preview instead calls a narrowly-scoped
`read_image_as_data_url` Rust command returning a base64 `data:` URL — no
`tauri.conf.json`/capability changes. Path resolution reuses `TauriWorld::file`'s
`..`-escape-proof `VirtualPath::realize` guard — the same primitive `typst-cli`'s own
`SystemWorld` uses for resolving asset paths. The Editor Model still only stores the relative path string, never
image bytes. `base_dir` (open document's directory) is threaded through every Rust
command that resolves a path. Custom PM NodeView (not `toDOM`) renders the image node,
closing over a live `documentDirRef`.

**M12 — Toolbar / UI polish.** Borrows the visual language of modern block editors
(Tiptap, PlateJS — floating/bubble toolbars, block drag-handles, slash-command menus)
without adopting either as a dependency: both are thin wrappers or a different core
entirely (PlateJS is built on Slate, not ProseMirror), and either would mean
re-expressing the existing schema/node views/position-mapping inside a foreign
framework. Implemented instead as ProseMirror plugins/decorations on the existing
`EditorView`:
- Floating/bubble toolbar on text selection (bold/italic/code/link).
- Slash-command menu (`/heading`, `/list`, ...), narrowly triggered only when `/` is a
  paragraph's entire content (can't misfire mid-sentence).
- Per-block hover `+` button: a single button tracked via mouse position
  (`posAtCoords`/`coordsAtPos`), not one decoration per block, living as a sibling of
  the scrollable content wrapper.
- File operations (Open/Save/Save As/Export/recent-files) moved from in-content
  buttons to a native app menu (`@tauri-apps/api/menu`); the DOM keydown listener was
  removed since the native menu now owns those accelerators. Content-editing toolbar
  buttons stayed inline.
- Fixed: WYSIWYG cursor disappearing on an empty line (missing
  `prosemirror-view/style/prosemirror.css`, which provides the caret-anchoring hack for
  empty text blocks) and `prosemirror-tables/style/tables.css` (missing since M10).
- Fixed: a table (or any other "closed" block) as the last document child left no way
  to move the cursor past it. Fixed generally — `ensureTrailingParagraphPlugin` always
  appends an empty paragraph when the last child isn't one, safe because an empty
  paragraph serializes to nothing.
- **Scope decision, not an oversight**: true drag-to-reorder wasn't built (needs
  pointer drag-start/move/drop tracking, unverifiable in this environment); block
  reordering is still reachable via cut/paste.
- **Verification gap**: mostly interactive UI (toolbar position, menu behavior, hover)
  that automated tests can't cover. What's verified: pure-logic unit tests, clean
  `tsc`/build, app launching without runtime error. Interactive behavior needs a manual
  `tauri dev` pass.

## Deferred past Phase 2

- **`#let`/`#show`/control-flow** — real semantic support (variable binding, scoping,
  rule application) is substantially larger than everything above combined; scoped as
  its own future phase.
- **Fidelity/precision work** — byte-exact WYSIWYG sync inside marked-up runs,
  range/selection-level highlighting, incremental compilation. Deferred because
  hardening sync/perf for a subset about to grow risked redoing the work twice.
- **Footnotes/citations, math mode, multi-file imports beyond images, collaborative
  editing** — unchanged from the MVP plan, still out of scope.

## Risks

- **Table representation risk**: the supported `#table(...)` shape is a heuristic, not
  a full argument-grammar parse — real-world tables (with styling args) are more likely
  to fall to opaque than other constructs. Budget time to widen the shape from real
  fixtures.
- **Image path/security risk**: M11 is the first milestone giving the Rust backend real
  filesystem access — scope tightly (document-directory-only, read-only) from the
  start.
- **Markdown fidelity gap widens**: GFM tables and image-caption-as-alt-text add two
  more deliberate lossy-but-stable fallbacks on top of the MVP's `unsupported_block`,
  consistent with but larger than the MVP's existing risk.
