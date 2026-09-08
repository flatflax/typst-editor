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
  - *Directly authored* (one contiguous source range, one contiguous rendered region)
    → directly editable in place.
  - *Indirectly produced* (a call's rendered output, auto-numbering, a footnote
    rendered elsewhere on the page) → still visible, but reached through source/semantic
    inspection, not direct in-place editing. See M15 in [phase3-single-view.md](phase3-single-view.md).
- **No** (`#set`, `#let`, imports, other directives with no visual footprint) → stays
  invisible by default, exposed only through an inspector addressed by source range —
  no dedicated PM node/schema entry. The `#set` "Document Settings" drawer (Phase 1)
  already follows this.

This narrows rule 1 rather than contradicting it: rule 1 governs constructs that *do*
need on-surface representation; rule 2 says a whole class of constructs may need none.

**Role split, revised after M15's negative result (see
[phase3-single-view.md](phase3-single-view.md)):** the original split — ProseMirror
owns the editing engine (cursor/selection/IME), Typst owns layout — assumed these
responsibilities can be divided across two independently-laid-out systems for the same
visual region. M15 falsified that assumption: cursor and selection are pixels that
must land between specific rendered glyphs, so whichever system renders the glyphs
must also own the cursor. Splitting them guarantees a visual seam exactly where the
user is looking (the focused region).

Corrected split: **Typst owns rendering and cursor/selection for on-surface content.**
The editing system supplies input capture (keystrokes, IME composition) and, for
structural edits (tables, lists, inserting a figure), a document-tree transform
applied via parse → transform → serialize — not a persistent on-screen editing
widget. The bridge is still `editor position ⇄ source range ⇄ Typst layout geometry`
(`jump_from_click`/`jump_from_cursor`, M1/M5; `geometry_for_range`, M14A), but the
geometry now drives the primary cursor, not just a click/selection sync nicety.
