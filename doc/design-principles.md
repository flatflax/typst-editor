# Design Principles

Two standing rules govern all work on this codebase, across every phase. Apply them
before adding anything new.

## 1. Primitives over nodes

Don't design toward "support more node types." Design a small, fixed set of editing
primitives that more node types can reuse. Before writing new parse/serialize/schema
logic for a content construct, check whether it fits an existing primitive:

- **Verbatim round-trip carry-through** — `unsupported_block`, `typst_call`, `typst_set`.
- **A recursive mark stacked via `addToSet`** — `link`.
- **A container whose children recurse through the same block/inline serializer as
  top-level content** — table cells (M10).

Judge a genuinely new primitive by whether *other future* node types could reuse it,
not just the one motivating it.

## 2. Typst decides visibility; the editing system decides interaction

For the single-surface model (Phase 3), whether a Typst construct gets a permanent
place in the ProseMirror schema depends on one test: **does it produce layout
geometry** (real, positioned ink in the compiled `Frame`)?

- **Yes** → primary content, rendered on the document surface.
  - *Directly authored* (one PM block, one contiguous rendered region) → directly
    editable in place.
  - *Indirectly produced* (a call's rendered output, auto-numbering, a footnote
    rendered elsewhere on the page) → still visible, but reached through source/semantic
    inspection, not a direct swap. See M15 in [phase3-single-view.md](phase3-single-view.md).
- **No** (`#set`, `#let`, imports, other directives with no visual footprint) → stays
  invisible by default, exposed only through an inspector addressed by source range —
  no dedicated PM node/schema entry. The `#set` "Document Settings" drawer (Phase 1)
  already follows this.

This narrows rule 1 rather than contradicting it: rule 1 governs constructs that *do*
need on-surface PM representation; rule 2 says a whole class of constructs may need
none. Role split: ProseMirror stays the editing *engine* (cursor/selection/IME/
transactions/undo/paste); Typst stays the layout *authority* (typography/geometry/
appearance); the bridge is `editor position ⇄ source range ⇄ Typst layout geometry`,
generalizing the point-mapping (`jump_from_click`/`jump_from_cursor`) built in M1/M5.
