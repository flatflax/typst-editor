# Phase 3 — Single-View WYSIWYG (active, M13–M17)

Architecture reference: [architecture.md](architecture.md). Design rules: [design-principles.md](design-principles.md).

## Reframing

The goal: one view, no separate preview pane, backed by real Typst rendering — made
feasible by fast-enough recompilation (M14, done for short/medium documents — see
below for the measured limit) and by mapping source ranges to rendered geometry (M14A,
done — see below). An earlier framing assumed single-view meant
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

Tentative — M14 and M14A were feasibility spikes M15+ depended on; both are now done
(see their entries for results and follow-on design notes for M15/M16). The perf
baseline task below is not part of that dependency chain (see its own entry for why).

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

**Perf baseline (parallel, non-gating) — in progress** (edit-position follow-up done,
full pipeline instrumentation not started). Instrument the existing
end-to-end pipeline (`parse_typst_ast` → `typstAstToDoc` → PM render/edit →
`pmDocToTypst` → `compile_typst` → preview render, plus IPC serialization between the
Rust/TS boundary) and measure wall time per stage for open and per-keystroke edit,
across a small sweep of fixture sizes (e.g. ~1, ~10, ~40 pages — reuse M14's
`multi_page_fixture` shape rather than a single "realistic medium" doc) so growth
trends are visible, not just one point-in-time number. Unlike M14/M14A, this isn't a
gate — it doesn't block and isn't blocked by anything below, and can run at any time
since the pipeline it measures already exists post-M13. Purpose is threefold: (1) find
out now whether any stage of the *current* loop is already a bottleneck worth fixing,
rather than assuming the Rust compile step is the only one that matters; (2) stand up
measurement infrastructure/tooling that M14A/M15 (geometry + swap latency) and M16
(reflow) each reuse for their own new perf surface instead of rebuilding
per-milestone; (3) double as an ongoing regression guard for M14's linear-in-pages
recompile-latency finding (below) — the per-size sweep should keep failing loudly if a
future change makes the scaling worse, or should stop showing the linear trend at all
once a session-held `World` (M14's follow-up (a)) actually lands.
- **Follow-up: vary edit position, not just document size — done, negative
  result.** Benchmarked in `src-tauri/src/compile.rs`
  (`recompile_latency_after_an_edit_depends_on_position_not_just_document_length`;
  release-mode numbers below). M14's table varied page count and edit-vs-no-edit but
  never *where* in the document the edit lands. Crossed two document lengths (14/40
  sections) with three edit positions (near-start/middle/near-end, persistent `World` +
  `Source::edit`) to separate two explanations for the linear-in-pages result: cost
  tracking *total document size* vs. cost tracking *content after the edit point*.

  | Sections | near-start | middle | near-end |
  |---|---|---|---|
  | 14 | ~21ms | ~29ms | ~28ms |
  | 40 | ~69ms | ~58ms | ~61ms |

  Edit position is within noise at each document length; the ~2.4x cost increase from
  14→40 sections roughly tracks the 2.9x section-count ratio regardless of where the
  edit landed.
  **Cost tracks total document size, not content after the edit point** — confirms
  M14's read that Typst's pagination pass is sequential over the whole document (a page
  break anywhere depends on cumulative height of everything before it) rather than
  scoped to the edit site. Rules out a bounded-window recompile at the *compile* layer
  (M16's undecided direction (a)) as a real lever — M16 should not pursue it on the
  premise that near-end edits are cheaper; whatever mitigates long-document latency has
  to act elsewhere (e.g. reducing recompile frequency/scope at the UI layer, or
  accepting the linear cost for long documents as a known limit).

**M14 — Incremental compilation feasibility spike — done, partial-negative
result.** Benchmarked in `src-tauri/src/compile.rs`
(`single_character_edit_on_a_multi_page_document_recompile_latency`,
`incremental_edit_on_a_persistent_world_shows_comemos_real_speedup`; release-mode
numbers below, `cargo test --release -- --nocapture`).

Measurements (release mode, synthetic multi-section fixture — see
`multi_page_fixture` in compile.rs):

| Architecture | Pages | Edit | Latency |
|---|---|---|---|
| Fresh `World` per call (today's `compile_typst`) | 14 | none (repeat compile) | ~75–110ms |
| Fresh `World` per call | 14 | 1 character | ~75–110ms |
| Fresh `World` per call | 27 | 1 character | ~240ms |
| Fresh `World` per call | 40 | 1 character | ~390ms |
| Persistent `World` + `Source::edit` | 14 | none (repeat compile) | ~9µs |
| Persistent `World` + `Source::edit` | 14 | 1 character | ~60ms |

- **Whole-doc recompile scales roughly linearly with page count, ~8–10ms/page.**
  It comfortably meets the *existing* 250ms debounce window (`COMPILE_DEBOUNCE_MS`,
  App.tsx) for short-to-medium documents (roughly ≤20 pages) but not the
  milestone's tighter ~16–50ms "instant-per-keystroke" target, and it keeps
  getting worse as documents grow — it is not the page-count-independent result
  M15+ would ideally want.
- **`comemo` doesn't rescue this, even with a persistent `World`.** The current
  `compile_typst` command builds a fresh `TauriWorld`/`Source` (fresh `FileId`) on
  every call, which discards `comemo`'s cache entirely — that alone explains why
  the fresh-`World` row is identical whether or not the source actually changed.
  Holding one `TauriWorld` alive and applying a real incremental edit via
  `typst_syntax::Source::edit` (the same mechanism `typst-cli --watch` uses) makes
  an *unmodified* repeat-compile nearly free (full cache hit), but a genuine
  one-character edit is still only modestly better than the fresh-`World` number
  at the same page count. Typst's flow/pagination pass is inherently sequential
  across the whole document (a page break anywhere depends on cumulative height of
  everything before it), so an edit can force re-layout of everything after it
  regardless of caching — `comemo` saves parse/eval work, not the page-layout pass
  itself.
- **Consequence for M15+**: whole-document recompilation is fast enough to *not
  block* starting M15 for realistic short/medium documents under the current
  debounce-based architecture, but the linear page-count scaling is a real,
  measured ceiling, not a hypothetical one — long documents (tens of pages) will
  feel laggy under a naive "recompile-and-swap on every keystroke" design. Two
  follow-ups: (a) switch `compile_typst`'s architecture from a fresh `World` per
  call to a session-held `World` + `Source::edit` — **done** (`compile.rs`,
  M15's first implemented slice; see below), a low-risk win regardless (near-free
  no-op recompiles) even though it doesn't fix the linear-in-pages cost of a real
  edit; (b) for long documents, M16's "bounded window" idea (recompile/reposition
  only the edited block's numbering/page scope, not the whole document) may need
  to apply at the *compile* layer, not just the reposition layer its current
  wording assumes — since resolved: the perf-baseline edit-position follow-up above
  shows it does *not* help at the compile layer; the reposition layer remains a
  separate, still-open question.

**M14A — Layout geometry spike — done, positive result.** Prototyped in
`src-tauri/src/geometry.rs` (`geometry_for_range`): given a source byte range, walk
every page's `Frame` tree and collect every rendered item whose span overlaps it —
the same span-matching `jump_from_click`/`jump_from_cursor` (`typst-ide`, jump.rs)
already do for a single point, generalized to a range and to collecting geometry
(page, x/y, width/height, baseline) instead of just a byte offset. 6 tests, each
checking one piece of what M15 needs:

| What M15 needs | Verified by | Result |
|---|---|---|
| Page(s) a range renders on | `a_range_crossing_a_page_break_yields_boxes_on_both_pages` | ✅ direct from per-page walk |
| x/y, width/height | `a_single_line_paragraph_...`, `an_image_yields_an_exact_size_box_...` | ✅ exact for images (`FrameItem::Image`'s own `Size`); approximated from font size for text (see below) |
| Baseline | `a_single_line_paragraph_...` (`baseline_from_top_pt`) | ✅ a `Text` item's frame position *is* its baseline — no extra API needed |
| Line boxes (one per wrapped line) | `a_wrapped_paragraph_yields_one_line_box_per_visual_line` | ✅, but reconstructed by clustering glyph hits with matching baselines — see limitation below |
| Fragment boxes (content pulled out of flow) | `a_footnote_body_is_locatable_even_though_it_renders_away_from_its_reference` | ✅ falls out for free — a footnote body's span still resolves to a real box wherever it actually renders |

Mechanism: each `Glyph` carries `span: (Span, u16)` — a syntax node span plus a
per-glyph byte offset within it — so `world.range(span).start + offset` gives the
*exact* source byte position of that specific glyph (the same computation
`jump_from_click_in_frame` does for click hit-testing), not just "this whole text run
overlaps somewhere." Checking that offset against the target range, per glyph, is
enough to collect every hit; `FrameItem::Image`/`Shape` carry one span for their whole
item instead.

Two real limitations, not blockers:
- **No explicit per-line boundary in `Frame` itself.** `Frame::push_frame` inlines
  ("flattens") short soft sub-frames (≤5 items) into their parent rather than keeping
  them as a nested `Group` — which is what a single-style text line normally is (one
  `FrameItem::Text` per style). So line boxes are reconstructed here by clustering
  glyph hits that share a page and baseline, not by reading an authoritative
  "line N" boundary off the tree. This worked cleanly on every fixture tried, but two
  genuinely different lines that happen to share an identical baseline (e.g. a
  multi-column layout) would currently merge into one box — untested, and would need
  an x-discontinuity check added to the clustering, not a different approach.
  Real font-metrics ascent/descent also aren't exposed per glyph run, only the font
  size used to lay it out — `geometry.rs` uses the same size-based approximation
  `typst-ide` itself uses for click hit-testing (jump.rs), which is precise enough to
  align an overlay but isn't the font's actual metrics.
- **`Group` transforms aren't composed**, only translated — `geometry_for_range`
  accumulates each nested frame's *position* but not `GroupItem::transform`'s
  rotation/scale. Correct for ordinary flow content (paragraphs, headings, lists,
  images — everything M15's swap mechanism scopes to), wrong under `#rotate`/`#scale`
  (out of M15's stated scope anyway). `jump_from_click_in_frame` already has the
  matrix-inversion code (`Transform::invert`/`Point::transform_inf`) this would need
  to reuse if that scope ever grows.

**Consequence for M15+**: no fallback to coarse per-block bounding boxes is needed —
`Frame` data, walked the same way `typst-ide` already walks it for click/cursor sync,
gives real line-level boxes with baselines and correctly locates content rendered
away from its source position (footnotes) or across a page break. M15 can build
directly on this rather than redesigning around a coarser data source.

**M15 — Direct-content render/edit swap (in progress — unblocked, M14/M14A both
done; their findings above, session-held `World` and glyph-span-based geometry, are
design inputs to build on).** Extend PM node views
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
- **First slice landed: session-held `World`.** `compile_typst` (`compile.rs`) now
  holds one `TauriWorld` per app session (`Mutex`, managed in lib.rs) instead of
  constructing one per call, applying each incoming full-document string as a
  diffed `Source::edit` (`compute_edit`: longest-common-prefix/suffix, snapped to
  UTF-8 char boundaries) rather than reparsing from scratch. The frontend's IPC
  shape is unchanged — it still sends the whole current document every call; only
  the backend's handling of repeated calls changed. `geometry_for_range` (M14A) is
  not yet wired to a command; the PM node-view swap UI itself hasn't started.

**M16 — Reflow and pagination handling.** An edited block's height change shifts
every later block's position (real Typst pagination, not CSS reflow) — the document
container must reposition subsequent fragments after each incremental compile.
Requires an explicit answer for a block straddling a page break (new UX territory;
the old split-pane preview never had to solve it). Implementation is blocked on M15
(needs the swap mechanism to reposition around); the scope question and interim
direction below are not — M15's swap-trigger scope depends on them, not the other
way around.
- **Open scope question (raised 2026-09-04).** M15/M16 assume a block is one
  contiguous, independently swappable unit whose neighbors only need
  *repositioning*, not re-rendering. That holds for Markdown/Typora but not fully
  for Typst: auto-numbering (heading/list numbers), `#set` rules (effective for
  everything after them), and footnotes (render at page bottom, not source position)
  mean editing one block can change *displayed content* of later untouched blocks,
  not just position — a correctness bug ("sibling shows a wrong number"), sharper
  than the general layout-dependency risk below. ~~Two candidate directions: (a)
  recompile-and-reposition a bounded window (edited block + everything after it in
  the same numbering scope/page) — more correct, more expensive; (b) accept
  staleness with a visible affordance (a "recompute" trigger, or full settle on
  blur).~~ Outdated: the perf-baseline edit-position follow-up (above) shows a
  bounded window costs the same as a full recompile, so (a) has no cost advantage
  now that whole-document recompile is the default (interim direction below); (b) is
  adopted below for page-break visual continuity only — this correctness bug is
  still undecided.
- **Interim direction (decided 2026-09-07), pending M16's own data below**: don't
  design invalidation yet — build on the whole-document recompile M14 already
  validated, and measure before choosing between whole-document / page-range /
  dependency-aware invalidation.
  1. Correctness baseline: keystroke → PM updates the active block immediately →
     debounce → whole-document compile + render → geometry settle. No bounded-window
     or dependency-aware invalidation until the data below shows it's needed. Debounce
     starts at 100–150ms as an experimental value, not fixed — M14 measured
     ~8–10ms/page for whole-doc recompile, so this window may need to widen once the
     settle-latency data (point 3) comes in.
  2. Cross-page active block: while editing, let the PM editing region expand
     continuously across the page break — the source stays paginated by Typst, only
     the editing surface ignores it — and restore real pagination on blur. This is
     the accept-staleness direction from the open scope question above, applied
     specifically to page-break visual continuity: it resolves only that half of the
     question, not the numbering/`#set`/footnote correctness problem (a sibling
     block showing wrong *content*, not just wrong position) above, which stays
     unresolved and needs its own decision.
  3. M16 records two datasets before deciding on invalidation strategy: (i) which
     pages/blocks actually show geometry/render changes after an edit at a given
     position; (ii) whole-document settle latency at 10/20/40 pages. Reuse M14's
     benchmark fixtures/tooling (`compile.rs`) rather than building new measurement
     infra. Note the perf-baseline edit-position follow-up (above) already answers part
     of (ii): settle latency is position-independent, a function of document length
     alone — so a compile-layer bounded window (recompute less by starting from the
     edit point) isn't a viable invalidation strategy; (i) remains open and targets a
     different lever (shrinking *render/swap* surface at the frontend layer after a
     whole-document compile, not shrinking the compile itself).

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
- **Page-boundary UX was genuinely undefined; now partly decided.** M16's interim
  direction (above) resolves the editing-surface half (the active block's editing
  region spans page breaks while focused; real pagination restores on blur) — the
  numbering/`#set`/footnote correctness half (Open scope question, above) is still an
  open product decision, needed before M15's swap-trigger scope is finalized.
- **M14A's line-box reconstruction is a heuristic (baseline clustering), not an API
  guarantee** — two visually distinct lines sharing an exact baseline (e.g. a
  multi-column layout) would currently merge into one box. Untested; would need an
  x-discontinuity check added before M15 relies on it for that case.
- **M14's measured linear-in-pages recompile cost** (above) means whole-doc
  recompile-and-swap will feel laggy on long documents even though it's fine for
  short/medium ones — M15/M16 need to design for this explicitly (session-held
  `World`, and/or reducing recompile frequency/scope at the UI layer — the
  perf-baseline edit-position follow-up above rules out a bounded-window recompile at
  the *compile* layer as a fix) rather than assume recompilation is free at any
  document length.
