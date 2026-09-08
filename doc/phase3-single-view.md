# Phase 3 — Single-View WYSIWYG (active, M13–M23)

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

Architecture was governed by [design-principles.md](design-principles.md) rule 2's
original role split (ProseMirror owns cursor/selection/IME, Typst owns rendering) —
see M15 below for how that splits into direct content (the swap mechanism) vs.
indirectly produced content (a source/semantic inspection interaction, deliberately
undesigned until a prototype exposes real cases). **M15 falsified the role split
itself, not just its first implementation** — see M15's entry below and
[design-principles.md](design-principles.md)'s revised rule 2.

**Revised framing (after M15).** Per-block focus swapping requires the swapped-in
editable view and the swapped-out rendered view to agree closely enough on
size/shape that neither the swap itself nor the seam between active and inactive
regions is visible — true for Typora (both views are CSS-laid-out) but not
achievable here, where the two views come from two independently-laid-out engines
(PM/CSS vs. Typst) rendering the same content differently. The corrected mechanism
(M18–M23 below) does not swap between two renderings of a block. It keeps one
rendering — Typst's, for the whole document, at all times — and adds a cursor/
selection layer drawn directly against that rendering's own geometry (M14A). See
each milestone below for detail.

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

**M15 — Direct-content render/edit swap — done, negative result.** Original goal:
extend PM node views so each top-level block that is both geometry-producing and
directly authored (paragraph, heading, list item, table, image, ...) presents as
either an inline Typst-rendered SVG fragment (inactive) or an editable node view
(active), toggling on focus/blur/click. Three mechanisms were built and discarded,
in order, each fixing the previous one's failure but exposing a new one. The
furthest-landed (#3 below) survives as a complete, working snapshot on branch
`spike/m15a-block-swap`, not merged to `main` — only the load-bearing pieces
(`block_geometry`, `geometry.rs`'s public API) were kept there.

1. **NodeView-based swap.** Wrapped `paragraph`/`heading` content in a custom
   `NodeView` that swapped between a rendered SVG fragment and PM's own
   `contentDOM`. Result: corrupted document content. `EditorView.nodeDOM`'s own
   doc comment warns against mutating a node's DOM this way ("will be immediately
   overriden by the editor as it redraws the node") — confirmed directly: PM's own
   reconciliation overwrote the manual swap on the next redraw, and a `NodeView`
   whose DOM shape diverges from the schema's own `toDOM` output confused PM's
   native-event handling.
2. **Absolute-positioned overlay.** Positioned the rendered SVG fragment via
   `position: fixed` + `getBoundingClientRect` over the live PM block instead of
   replacing its DOM. Fixed the corruption, but reintroduced two problems
   computed-pixel overlays have inherently: the CSS-rendered box's aspect ratio
   doesn't match the Typst-rendered crop's native aspect ratio (visible
   stretching), and viewport-relative positioning needs recomputing on every
   scroll.
3. **Before/after crop.** Rendered exactly two crops — everything before the
   active block, everything after it — as plain flow siblings around the live PM
   block (its other top-level siblings hidden via a decoration), so all three
   pieces share one native scroll container and no pixel-position tracking is
   needed (`activeBlockPlugin.ts`, `blockSwapGeometry.ts`, `sharedSvgHost.ts`).
   Furthest-landed of the three, but exposed two problems that don't reduce to
   more engineering:
   - **Single-page only, and not fixable by more work**: a "before crop" that
     spans a page break isn't a single rectangle — `svg_merged`'s page stacking
     has no representation this crop shape can union into one box. M14A's own
     single-page scope carried through as a limitation to lift later; here it's
     the crop shape itself breaking down for multi-page documents.
   - **The seam lands exactly where the user is looking.** The active block is
     PM/CSS-rendered; its neighbors are Typst-rendered. Different layout engines
     give materially the same content different line breaks, spacing, and font
     metrics — the visual mismatch is worst at the one block currently focused,
     the opposite of what "single view, always real Typst rendering" was meant
     to deliver.

**Root cause: a design-principle failure, not an implementation defect.**
[design-principles.md](design-principles.md) rule 2 (pre-revision) split ownership
as "ProseMirror owns the editing engine (cursor/selection/IME); Typst owns layout."
That split cannot be implemented for a single visual region: cursor and selection
are pixels that must land between specific rendered glyphs, so whichever system
lays out the glyphs must also own the cursor drawn into them. Any split of that
ownership across two independently-laid-out systems guarantees a seam at the
focused block, regardless of how the swap is engineered. Rule 2 is revised
accordingly — see [design-principles.md](design-principles.md).

**M14's perf standard was also the wrong standard.** M14 benchmarked whole-document
recompile against a "recompile every keystroke in under 16–50ms" bar, modeled on
synchronous swap-on-keystroke. The standard every mainstream rich-text/DTP editor
actually uses is optimistic local echo plus a debounced settle (Word, Google Docs),
not synchronous per-keystroke recompile. Under that standard, M14's own numbers
(tens of ms for short/medium documents) are workable — M14's result stands, but its
framing as a tight per-keystroke ceiling does not.

**Disposition of the milestones this cancels:**
- **M15b** (extend the swap to table/image/list) is moot — there is no swap
  mechanism left to extend.
- **M17** (cursor continuity across swaps) is moot — there is no swap to be
  continuous across. Click-to-position becomes part of the primary cursor
  mechanism itself (M20 below), not a generalization of activating a node view.
- **M16** (reflow/pagination) is not cancelled, but its hardest sub-problem
  dissolves: the "sibling shows stale numbering/`#set`/footnote content" bug (its
  open scope question, previously undecided) cannot occur once the display is
  always a whole-document recompile-and-redraw with no cached or cropped
  fragment to go stale. Only a latency/visual-continuity question remains — see
  M22.
- The `TauriWorld` session-holding work first landed under M15 (`compile.rs`) is
  kept — it is load-bearing for M21, independent of the swap mechanism's fate.

**Revised mechanism (M18–M23 below).** Typst renders the whole document, at all
times, as one multi-page SVG — no per-block swap, no cropping. Cursor and
selection are drawn by the editing system directly from that rendering's own
geometry (M14A's `geometry_for_range`/`jump_from_click`), not by a second,
independently-laid-out engine. A hidden input element captures keystrokes and IME
composition; structural edits (tables, lists, inserting a figure) go through a
parse → transform → serialize round trip rather than a persistent PM DOM tree. See
[design-principles.md](design-principles.md)'s revised rule 2 for the corrected
role split.

**M18 — CJK IME composition spike — done, positive result.** The one risk
M14/M14A didn't cover, and the one open question deciding whether M20–M23 are
worth building: can a self-drawn cursor/selection layer over a static
Typst-rendered SVG host CJK IME composition acceptably? Tested manually
(composition can't be exercised meaningfully by synthetic events) against real
Chinese (Microsoft Pinyin), Japanese, and Korean IMEs on Windows, using the
harness at `spike/m18-ime/index.html` — a standalone static page, no build
step, no compile/backend integration at runtime (its background SVG was
compiled once from the real `compile_typst` pipeline, so its glyphs are real
Typst output, not a CSS mockup). Result: **yes, for all three**, with two
harness bugs found and fixed along the way and one architectural finding to
carry forward.

- **The full-replace model holds for all three languages, including the
  hard cases.** The harness always sets the composition overlay to
  `compositionupdate`'s `data` field wholesale, never a diff/append. This
  correctly handles Chinese's wholesale-replace-on-candidate-selection,
  Japanese's candidate *cycling* (confirmed live: `きょう` → `今日` → `協力`
  → back to `今日` — unrelated kanji candidates for the same reading, not
  extensions of each other, delivered through the identical event/field), and
  Korean's in-place jamo-to-syllable replacement (`ㄴ` → `내` → `낸`, each a
  full replace of the previous, not an append).
- **No segment/clause-boundary information is exposed by the standard
  Composition Event API.** Nothing in `compositionupdate` distinguishes "you
  typed another character" from "you cycled to a different candidate for an
  existing segment," and nothing marks a Japanese multi-segment composition's
  confirmed vs. unconfirmed clauses. Not a blocker: the full-replace model
  never needed that distinction to render correctly, and the OS's own
  candidate popup already shows segment/clause state visually — a page-level
  overlay doesn't need to reproduce it.
- **Korean commits per-syllable, not per-word — a real frequency difference
  for M20/M21 to design for.** Chinese and Japanese ran one long
  `compositionstart`…`compositionend` per phrase; Korean fired a full
  start/update/end cycle per syllable (sometimes per single jamo), confirmed
  live: `ㄴ→내→낸→(end "낸")→(start)→ㅁ→므→(end "므")→...`. An
  implementation that assumes "one composition ≈ one word" will see far more
  composition-lifecycle churn per second of typing for Korean than for
  Chinese/Japanese. The harness already handles this correctly (each
  `compositionend` commits and advances the caret independently, regardless
  of how short-lived the composition was) — the finding is about expected
  event *frequency*, not a correctness gap.
- **Candidate-window positioning is correct, confirmed visually (not just
  inferred from the log) for all three languages.** Positioning the real
  (if visually tiny and transparent) `<input>` element at the caret's actual
  screen location was sufficient for the browser/OS to anchor its native
  candidate popup correctly — no dedicated IME-positioning API call was
  needed beyond keeping that element's position in sync with the caret.
- **Two real bugs found and fixed in the harness's own logic** (not the
  browser/OS) — both are genuine lessons for M20/M21, not spike-only quirks:
  1. Chromium fires the terminal `input` event for a composition emptied via
     backspace with `isComposing:false` and `inputType:"deleteContentBackward"`,
     ~0.3ms *before* `compositionend` actually fires. Code that trusts that
     event's `isComposing` flag will treat a cancelled composition as a real
     backspace and delete a character from already-committed content instead.
     Fix: track composition state with your own flag (set on
     `compositionstart`, cleared on `compositionend`), not the individual
     event's own flag.
  2. A self-drawn caret does not automatically track the growing/shrinking
     end of an in-progress composition — it must be explicitly repositioned
     on every `compositionupdate` (here, via the overlay's own rendered
     width), or it stays frozen wherever the composition started for its
     whole duration.
- **Not tested, and out of scope for this milestone**: arrow-key navigation
  through already-committed text. That needs a real position↔geometry
  mapping (M14A's `geometry_for_range`), which is M20's job, not something
  this harness approximates.

**Consequence for M20+**: the one existential risk blocking this direction is
cleared. M20 can start.

**M20 — Static cursor, selection, and hit-testing on live Typst rendering —
done, positive result.** Click-to-position, arrow-key navigation (with Shift
to extend), and drag-to-select directly against the full-document Typst SVG,
using M14A's `geometry_for_range`/`jump_from_click` — no text editing yet, no
IME (M21). Independent of M18 (pure geometry/hit-testing) — ran in parallel
rather than after it. New "Live cursor (M20)" view mode in `App.tsx`,
alongside (not replacing) WYSIWYG/Typst/Markdown — the first milestone since
M12 with a directly visible, positive result: a real caret blinking on real
Typst-rendered text, clickable and navigable, confirmed working after six
rounds of manual testing.

- **Fixed a real, pre-existing gap this milestone's own premise depends on**:
  `jump_from_click` (jump.rs, M1-era) hardcoded `document.pages().first()` —
  a click anywhere on `svg_merged`'s full multi-page output beyond page 1 was
  silently hit-tested against page 1's content instead. Harmless for the old
  split-pane preview (MVP documents fit on one page, and click-sync was a
  nicety); a real correctness gap for M20, whose whole point is a clickable
  *full* document. Fixed via a new `geometry::page_offsets_pt` (the merged-
  coordinate-space Y where each page starts, mirroring `svg_merged`'s own
  stacking arithmetic exactly via a shared `PAGE_GAP_PT` constant) — used by
  `jump_from_click` to resolve which page a merged-Y click point actually
  falls on, and returned to the frontend via `CompileResult` so `RangeBox`
  geometry (page-relative) can be placed on the single rendered SVG
  (merged-absolute). 3 new Rust tests (`geometry.rs`, `jump.rs`).
- **Mechanism**: the compiled SVG renders once, unmodified; a second `<svg>`
  overlay with the identical `viewBox` sits exactly on top via CSS and holds
  only the caret/selection `<rect>`s — both in the same pt coordinate space,
  so no px conversion is needed to *draw* them (only to *hit-test* a click,
  via the existing `svgPointFromClient`, now shared from `util/svgGeometry.ts`
  instead of living only in `App.tsx`).
- Caret placement prefers the leading edge of the character after the
  cursor, falling back to the trailing edge of the character before it (end
  of document, or an empty "after" query) — doesn't attempt to resolve
  line-wrap-boundary affinity, a known heuristic limit inherited from
  M14A's line-box clustering. Drawn height is trimmed to the glyph's own
  baseline (`visualHeightPt`), not `geometry.rs`'s full ascent+descent hit-
  testing box (see bugs below).
- **Up/Down navigation searches real line geometry, not a guessed
  distance.** `nearestAdjacentLine` (`editor/typstCursor.ts`) fetches every
  line box in the document (cached per `source` string) and finds whichever
  one sits strictly above/below the caret's current line — a synthesized
  click then lands at that real line's vertical center, clamped
  horizontally (`clampXToLine`) to a sticky "preferred X" column. Line
  spacing genuinely differs across block types (heading vs. body text vs.
  list item), which is exactly why an earlier guessed-multiplier version of
  this (see bugs below) could never fully work.
- Pure geometry/offset math lives in `editor/typstCursor.ts` (box→absolute-
  position conversion, caret placement, line search, UTF-8-byte code-point
  stepping), tested independently of React/Tauri — the component
  (`editor/TypstLiveView.tsx`) only wires it to `invoke` calls and DOM events.
- Drag-select coalesces `jump_from_click` calls to the latest mouse position
  rather than queuing every `mousemove` — that command isn't on the
  session-held `World` `block_geometry` uses, and an uncoalesced fast drag
  could both lag and resolve out of order. Up/Down presses are queued
  instead (a real FIFO, not "coalesce to latest") since a discrete keypress
  must not be dropped the way a continuous mouse position can be.

**Seven rounds of manual testing found seven real bugs, all fixed** — the
production-code equivalent of M18's IME testing loop, and a useful
reminder that M14A's/jump.rs's geometry approximations were validated for
*hit-testing* (generous, forgiving) and needed real correction once the
same numbers were used to *draw* something or navigate by real distance:
1. **Caret drawn visibly too low.** `geometry.rs`'s glyph-box approximation
   (`ascent = full font size`, `descent = ascent × 0.25`) deliberately
   overshoots on both ends for generous hit-testing — real ascent is well
   under a full em, and the 25%-below-baseline descent exists for glyphs
   that don't actually have one. Fine for click matching; visibly wrong once
   drawn as a caret bar, which read as hanging into the next line's space.
   Fixed by trimming the drawn height to `baseline_from_top_pt`.
2. **Up/Down silently failing intermittently.** The handler used `caretRect`
   React state as the "current position," but that state is populated by an
   async effect one round-trip behind `cursorOffset` — pressing Up/Down
   again before that effect resolved computed the next target from a stale
   box, occasionally landing back where it started. Fixed by fetching
   geometry fresh (via a `cursorOffsetRef` mirror, since rapid key-repeat
   also outruns React's render cycle) at the moment each press is processed.
3. **Caret/selection X-offset appeared only in a maximized window.** Root
   cause: `.typst-live-view`'s flex column defaulted `.typst-live-stage` to
   `align-items: stretch`, stretching it to the *container's* full width —
   wider than the actual rendered SVG whenever the window was wide enough
   that `max-width: 100%` wasn't the binding constraint (it only ever
   shrinks, never grows past the SVG's intrinsic size). The overlay `<svg>`
   (sized to 100% of that too-wide box) then centered its content via its
   default `preserveAspectRatio` inside slack width the real, left-aligned
   SVG didn't have — invisible in a narrow window, visibly offset once
   maximized. Fixed with `align-self: flex-start` on `.typst-live-stage`.
4. **Up/Down still unreliable after a distance-tuning attempt.** An
   intermediate fix widened the guessed step distance empirically (measured
   against a real sample document); still failed differently across block
   types — skipped a paragraph's first wrapped line moving down from a
   heading, didn't move at all between short list items, skipped a list's
   last item moving up into it. No single multiplier of "the current line's
   own height" can hold across headings/paragraphs/list items, which have
   genuinely different line spacing — replaced with the real-geometry
   search (`nearestAdjacentLine`) described above, not a better guess.
5. **Up/Down froze moving onto a shorter line.** `nearestAdjacentLine`
   correctly found the target line, but the synthesized click still aimed
   at the old (sticky) X position — past where a *shorter* line's content
   actually ends, `jump_from_click` had nothing to resolve to. Fixed with
   `clampXToLine`, clamping only the click's target, not the stored sticky
   column (so returning to a longer line later still snaps back to the
   original one).
6. **Clicking blank space did nothing** — past a short line's end, below the
   last line, in the margins, or in the gap between lines, `jump_from_click`
   had nothing there to resolve to and returned nothing, same underlying
   problem as bug 5 but for a *direct* click (no "current line" to clamp
   against, since finding the right line is the point of a click). Fixed
   with `lineContainingY` (nearest line whose vertical span contains the
   point, or nearest by center distance otherwise) plus the same
   `clampXToLine`, shared by both click-to-position and drag-select.
7. **A fast click sometimes got stuck in drag mode** ("recognized as a long
   press"). Race condition: `handleMouseDown` set the dragging flag inside
   `offsetAtClient`'s async `.then()`, not synchronously on mousedown. A
   fast click's `mouseup` could clear that flag *before* the promise
   resolved; the resolution then set it back to `true` afterward, leaving
   drag-mode stuck on with the button already released — every following
   mouse movement then extended a selection. Fixed by setting the flag
   synchronously at the top of `handleMouseDown`.

**M21 — Edit loop: keystroke to whole-document recompile-and-redraw (not
started — M18 and M20, its two dependencies, are both done).** Keystroke → edit the session `World`'s source →
whole-document recompile (the existing single session `World`, M14's
already-validated numbers — e.g. ~60ms for a 14-page document) → replace the
rendered SVG → redraw cursor from fresh geometry. No block-scoped or
second-`World` compilation for v1 — a bounded-window/block-level compile is
deferred and built only if long-document latency proves unacceptable in practice,
not designed up front. Also measures two costs the M14/M14A benchmarks don't
cover: replacing/repainting the SVG DOM itself on every keystroke (distinct from
Typst's own compile time, and potentially significant for a large multi-page SVG),
and preserving scroll position across a full-SVG swap.

**M22 — Settle-window UX and live reflow (not started; supersedes M16).** What
the document shows during the recompile-latency window between a keystroke and
the next redraw, and the accepted UX of later content visibly shifting position
as the user types (real re-pagination, not CSS reflow — precedented by Word/
Google Docs' own live reflow). M16's hard correctness question (a sibling block
showing stale content) is resolved by construction under M21 (see M15's
disposition notes above); only the latency/visual-continuity question remains
open here.

**M23 — Port Phase 2 editing affordances (not started).** Table editing, the
slash-command menu, the floating toolbar, and list operations — currently built
on PM's persistent DOM tree — reimplemented against the parse → transform →
serialize model (M15's finding: PM, where still used, becomes an on-demand
structural transformer, not a persistent editing surface). Largest-effort
milestone here; lowest technical risk.

## Risks

- **Cross-block layout dependencies (resolved by the revised mechanism).**
  A block's compiled size/appearance isn't purely a function of its own content
  (earlier `#set` rules, auto-numbering, widow/orphan control) — this was a real
  risk for a per-block swap, which needed neighbors to stay correct without being
  re-rendered. Under M21's whole-document recompile-and-redraw, every visible
  block is always freshly rendered, so this risk no longer applies.
- **Page-boundary UX (resolved by the revised mechanism).** The old open scope
  question — an edited block's numbering/`#set`/footnote effects could leave a
  stale-content sibling under a per-block swap — no longer applies once nothing is
  cached or cropped independently (see M15's disposition notes). Only the settle-
  window/live-reflow UX question remains, tracked as M22.
- **M14A's line-box reconstruction is a heuristic (baseline clustering), not an API
  guarantee** — two visually distinct lines sharing an exact baseline (e.g. a
  multi-column layout) would currently merge into one box. Untested; would need an
  x-discontinuity check added before M20 relies on it for that case. This risk
  gained weight after M15: line boxes now drive the primary cursor (M20), not just
  an optional preview-sync overlay, so a wrong merge is now a visible editing bug,
  not a cosmetic one.
- **M14's measured linear-in-pages recompile cost** means whole-document
  recompile-and-redraw will feel laggy on long documents even though it's fine for
  short/medium ones. M21 accepts this for v1 (optimistic local echo + debounced
  settle, not synchronous per-keystroke recompile — see M15's perf-standard
  correction) rather than solving it upfront; a bounded-window/block-level compile
  is deferred until real usage shows it's needed (the perf-baseline edit-position
  follow-up already rules out a compile-layer bounded window as a fix, so any such
  future work would need a different lever).
- **CJK IME composition (M18) — resolved, positive.** Was the mechanism's one
  unvalidated risk; now traces to a real test against Chinese/Japanese/Korean
  IMEs, same as geometry/hit-testing/recompile cost. One residual risk carried
  forward: Korean's much higher composition-lifecycle event frequency
  (per-syllable, not per-word) is a load characteristic M20/M21 should keep in
  mind, not a correctness gap — see M18's entry above.
