# Phase 3 — Single-View WYSIWYG (active, M13–M17)

Architecture reference: [architecture.md](architecture.md). Design rules: [design-principles.md](design-principles.md).

## Reframing

The goal: one view, no separate preview pane, backed by real Typst rendering — made
feasible by fast incremental compilation and by mapping source ranges to rendered
geometry (M14/M14A, both open questions). An earlier framing assumed single-view meant
hand-rolling cursor/selection/IME directly on the compiled SVG/Frame output — an
open-ended rewrite, correctly rejected for the MVP.

That framing was incomplete: **Typora doesn't do that either.** Typora's mechanism is
*per-block focus swapping* — the focused block shows a lightly-styled editable view,
every other block shows fully rendered output, swapped on focus/blur.

Applying that mechanism here turns single-view into a scoped integration problem:
**ProseMirror keeps owning text editing** (already solved); **Typst keeps owning
rendering** (already solved via `compile_typst`). The new work is:
(a) incremental compilation fast enough to recompile-and-swap on focus change/keystroke
without visible lag (M14),
(b) extending point-only position-mapping (`jump_from_click`/`jump_from_cursor`, M1/M5)
to return rendered geometry for a source *range*, not just a point (M14A),
(c) a block-level focus-swap UI on PM node views using both.

Architecture is governed by [design-principles.md](design-principles.md) rule 2 (the
role split and the geometry visibility rule) — see M15 below for how that splits into
direct content (this milestone's swap mechanism) vs. indirectly produced content
(a source/semantic inspection interaction, deliberately undesigned until the prototype
exposes real cases).

## Milestones

Tentative — M14 and M14A are feasibility spikes the rest depend on.

**M13 — Node-type dispatch refactor — done.** Not part of the single-view mechanism
itself; landed ahead of the next content node type. `spokes/markdown.ts`/
`spokes/typstAst.ts` dispatched each node type through up to six near-duplicate
`switch` statements — increasingly error-prone as the node count grows toward full
Typst content coverage (footnotes, math, grids, citations, ...).
- Scope: content-shaped node types only (attrs + children, symmetric conversion) — not
  `#let`/`#show`/control-flow (categorically different: variable binding/scoping, not
  node conversion).
- Inline layer collapsed into one shared table
  (`INLINE_ATOM_SPECS_BY_PM_TYPE` in `spokes/inlineLeaves.ts`) since those conversions
  are already context-free 1:1 leaf mappings.
- Block layer kept as separate per-direction functions (not a unified table) — several
  cases are lookahead/accumulation over siblings (image-from-sole-child,
  `#set` hoisting, list-item shape validation, table's flat cell grid), which would
  leak parent/sibling context into a per-node table.
- Structural position-validity (e.g. a list can't be a list-item's primary content) is
  now declared centrally in `schema.ts` (`LIST_ITEM_PRIMARY_TYPES`/`LIST_TYPES`/
  `BLOCK_NODE_TYPES`) instead of enforced by switch-case omission.
- Switches on `node.type.name` now cast against a literal union with
  `default: return assertNever(kind)`, so a missing case fails to compile.
- Landed as a pure refactor (zero behavior change) gated on the existing round-trip
  suite passing unchanged, before any new content node type is added on top.

**M14 — Incremental compilation feasibility spike (not started).** Before designing
the swap UI, establish the actual latency budget. `typst::compile` already uses
`comemo`-based memoization internally — benchmark whether recompiling the *whole*
document after editing one block of a realistic multi-page fixture already lands
under a per-keystroke budget (~16–50ms), before assuming block-scoped/partial
compilation is required. If whole-doc recompilation is fast enough, M15+ is
simpler (no need to isolate a block's output from document-level context); if not,
this produces a concrete measurement of the wall, informing whether block-scoped
compilation is worth its complexity.

**M14A — Layout geometry spike (not started).** Companion to M14; prerequisite for
M15's swap positioning and M16's reflow. `jump_from_cursor` currently returns only a
single `Point` per source position. M15 needs, for an arbitrary source byte range
`[a, b]`: page(s) it renders on, x/y position, width/height, baseline (to align an
editable view with its rendered counterpart), line boxes (one per soft-wrapped visual
line), and fragment boxes (one per disjoint rendered fragment, for content pulled out
of flow). Deliverable is whether `typst::layout`/`typst-ide`'s `Frame` data exposes
this cleanly, or needs deeper Rust-side Frame-walking. If not obtainable, M15 falls
back to coarser per-block bounding boxes only (no baseline alignment, no sub-block
fragments) — a call to make before M15 starts.

**M15 — Direct-content render/edit swap (blocked on M14/M14A).** Extend PM node views
so each top-level block that is both geometry-producing and directly authored
(paragraph, heading, list item, table, image, ...) presents as either an inline
Typst-rendered SVG fragment (inactive) or today's editable node view (active),
toggling on focus/blur/click — not on every keystroke of a different block. The
preview pane goes away; its role is absorbed into per-block rendered fragments.
- Scope: applies only to content authored in place (one PM block, one contiguous
  rendered region). `#set`/`#let`/imports are excluded by construction (no geometry).
- Indirectly produced content (a `typst_call`'s rendered output, auto-numbering,
  footnotes rendered elsewhere) is a separate case — needs source/semantic inspection,
  not a direct swap. The addressing scheme for it (hierarchical tuple-path keys, e.g.
  `("footnote", 3)`, akin to `pytorch/tensordict`'s `NestedKey`) is deferred until the
  prototype exposes concrete cases.

**M16 — Reflow and pagination handling (blocked on M15).** An edited block's height
change shifts every later block's position (real Typst pagination, not CSS reflow) —
the document container must reposition subsequent fragments after each incremental
compile. Requires an explicit answer for a block straddling a page break (new UX
territory; the old split-pane preview never had to solve it).
- **Open scope question (raised 2026-09-04, decide before M15 starts)**: M15/M16
  assume a block is one contiguous, independently swappable unit whose neighbors only
  need *repositioning*, not re-rendering. That holds for Markdown/Typora but not fully
  for Typst: auto-numbering (heading/list numbers), `#set` rules (effective for
  everything after them), and footnotes (render at page bottom, not source position)
  mean editing one block can change *displayed content* of later untouched blocks, not
  just position — a correctness bug ("sibling shows a wrong number"), sharper than the
  general layout-dependency risk below. Two candidate directions, not chosen: (a)
  recompile-and-reposition a bounded window (edited block + everything after it in the
  same numbering scope/page) — more correct, more expensive; (b) accept staleness with
  a visible affordance (a "recompute" trigger, or full settle on blur). Needed before
  M15's swap-trigger scope (which blocks re-render vs. just reposition) can be built.

**M17 — Cursor/selection continuity across swaps (blocked on M15).** Generalize
`jump_from_click`/`jump_from_cursor` so clicking a rendered (inactive) block activates
its editable node view at the corresponding character offset, and blurring re-renders
it — promoting the M5 position-mapping from an optional preview-sync nicety to
load-bearing infrastructure firing on every click.

## Risks

- **Cross-block layout dependencies**: a block's compiled size/appearance isn't purely
  a function of its own content (earlier `#set` rules, auto-numbering, widow/orphan
  control) — full accuracy may need re-rendering a window of neighbors. Scope the
  first version to accept some inaccuracy rather than solving this upfront.
- **Page-boundary UX is genuinely undefined** — decide as a product call before
  building M15, not during.
- **M14/M14A are hard gates**: if M14 shows incremental recompilation can't hit an
  acceptable latency budget even for whole-doc recompilation, or M14A shows stable
  per-range geometry isn't obtainable from `Frame` data, the M15+ milestone plan needs
  revisiting (block-scoped partial compilation, or a coarser bounding-box-only
  fallback, are both bigger lifts than sketched above) before further design or
  implementation time is spent.
