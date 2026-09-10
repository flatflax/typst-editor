# Typst WYSIWYG Editor — Plan

## Status

| Phase | Milestones | Scope | Status |
|---|---|---|---|
| 1 — MVP | M0–M6 | Prove `Source ⇄ Editor Model ⇄ Typst` forms a stable, round-trippable closed loop | Complete |
| 2 — Content & File I/O | M7–M12 | File I/O, PDF export, links, tables, images/figures, toolbar/UI polish | Complete |
| 3 — Single-View WYSIWYG (engineering validation) | M13–M22 | Validate that single-view editing is technically feasible: perf ceiling, rendered geometry, CJK IME, a working edit loop | Closed 2026-09-09 — feasibility validated (M14/M14A/M18/M20/M21/M22 positive, M15 negative but superseded); M23 deprioritized to backlog |
| 4 — Product Validation | Spikes 1–3 | Validate the "focus-reveals-source" interaction model before further engineering investment | In progress — Spikes 1–3 (lazy and eager) feel-tested and fixed live, incl. two bugs found only on real hardware; lazy adopted; remaining: independent user validation of true WYSIWYG as a real pain point |

Details: [Phase 1 — MVP](doc/phase1-mvp.md) · [Phase 2 — Content & File I/O](doc/phase2-content-io.md) · [Phase 3 — Single-View WYSIWYG](doc/phase3-single-view.md) · [Phase 4 — Product Validation](doc/phase4-product-validation.md) · [Interaction Design](doc/interaction-design.md) · [Architecture](doc/architecture.md) · [Design Principles](doc/design-principles.md)

## Product goal

A desktop Typst editor for writers who already know Typst syntax and want faster
everyday input — not a syntax-free editor. The core promise is **true WYSIWYG** (the
industry's own term for this specific property — see
[doc/interaction-design.md](doc/interaction-design.md) §4/footnote; this doc used to
call it "zero render drift," a made-up term now retired): what's on screen while
editing is never an approximation, because it's always the real Typst compiler's own
output, not a second layout engine's guess, inside a single visual surface (no separate
preview pane). See [doc/interaction-design.md](doc/interaction-design.md) for the
current product positioning (2026-09-09; supersedes the earlier "edits like
Typora/Notion, zero syntax" framing — "zero syntax" was dropped as a goal, replaced by
**focus-reveals-source**, see that document §6) and [Phase 3](doc/phase3-single-view.md)
for the engineering feasibility work that validated this is achievable.

The MVP (Phase 1) proved a narrower goal first: `Source ⇄ Editor Model → Typst
Compiler → Layout/Render` forms a stable closed loop, without attempting single-view
editing.

**Locked scope decisions** (do not revisit without confirming a change in direction):
1. Phase 1's WYSIWYG was a rich-text editing surface + separate accurate preview pane
   (split-pane), not single-view editing on Typst's real paginated layout — correct
   scope while the loop itself was unproven. Single-view WYSIWYG has since been
   confirmed as the long-term target (Phase 3).
2. Markdown is a first-class second source format, requiring real Markdown ⇄ Editor
   Model conversion, not just a UX reference — Typst source and Markdown source are
   two independent spokes around the same Editor Model hub.

## Design principles

Two standing rules govern all future work, not just one phase — see
[doc/design-principles.md](doc/design-principles.md) for full rationale:
1. **Primitives over nodes** — a small, fixed set of editing primitives should cover
   more node types over time, not bespoke parse/serialize/schema plumbing per node.
2. **Typst decides visibility; the editing system decides interaction** — a construct
   is directly editable in place only if it produces layout geometry *and* is
   directly authored; otherwise it stays inspector-only, addressed by source range.
   Revised after M15 (below): Typst owns visual geometry only; the editing system
   owns cursor/selection state and navigation, rendered against that geometry —
   never a second, independently-laid-out system.

## Phase 3 — closed (engineering validation)

Full detail, including the complete M13–M22 milestone record and M23's status at
closing, is in [doc/phase3-single-view.md](doc/phase3-single-view.md). Summary: M13
(dispatch refactor), M14/M14A (perf and geometry feasibility spikes), M18 (CJK IME
spike), and M20/M21/M22 (a working self-drawn-cursor editing loop on live Typst
rendering — the "Live cursor" view) are all done, with M15's per-block swap mechanism
built three times, found fundamentally unworkable, and superseded by that same
self-drawn-cursor mechanism (see M15's entry for the design-principle correction this
forced — reflected in [design-principles.md](doc/design-principles.md) rule 2). M23
(porting Phase 2's table/toolbar/slash-menu affordances onto the new mechanism) is
partially done (slice 1 committed, slice 2 uncommitted) and deprioritized to backlog:
per [doc/interaction-design.md](doc/interaction-design.md), the project now moves from
engineering validation to product design, and finishing M23 isn't required to validate
that direction.

## Current focus: Phase 4 — Product Validation

Full detail, including the spike plan and priority order, is in
[doc/phase4-product-validation.md](doc/phase4-product-validation.md). Summary: Phase 3
validated the *engineering* feasibility of single-view editing;
[doc/interaction-design.md](doc/interaction-design.md) (2026-09-09) is the product
design that follows, proposing **focus-reveals-source** (a focused block becomes a
native, editable source-text region; every other block stays fully rendered) as a
refinement of M20–M22's mechanism rather than a restart. Spike 1 (single-paragraph
focus/blur swap) is next.
