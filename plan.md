# Typst WYSIWYG Editor — Plan

## Status

| Phase | Milestones | Scope | Status |
|---|---|---|---|
| 1 — MVP | M0–M6 | Prove `Source ⇄ Editor Model ⇄ Typst` forms a stable, round-trippable closed loop | Complete |
| 2 — Content & File I/O | M7–M12 | File I/O, PDF export, links, tables, images/figures, toolbar/UI polish | Complete |
| 3 — Single-View WYSIWYG (engineering validation) | M13–M22 | Validate that single-view editing is technically feasible: perf ceiling, rendered geometry, CJK IME, a working edit loop | Closed 2026-09-09 — feasibility validated (M14/M14A/M18/M20/M21/M22 positive, M15 negative but superseded); M23 backlogged at closing, later picked back up under Phase 4 (see below) |
| 4 — Product Validation | Spikes 1–3, then real implementation | Validate the "focus-reveals-source" interaction model, then build it out as the Live cursor view's real editing mechanism | In progress — spikes validated (2026-09-10) and landed as Live cursor's real editing mechanism; several P0/P1 items shipped since (see below); shipped a whole-document compile-failure fallback (freeze last good render, red error placeholder — 2026-09-17/18); independent user validation still not started |

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
   never a second, independently-laid-out system. Superseded again, for the Live
   cursor view specifically, once focus-reveals-source was adopted: a focused block is
   always directly editable, geometry or not.

## Phase 3 — closed (engineering validation)

Full detail, including the complete M13–M22 milestone record and M23's status at
closing, is in [doc/phase3-single-view.md](doc/phase3-single-view.md). Summary: M13
(dispatch refactor), M14/M14A (perf and geometry feasibility spikes), M18 (CJK IME
spike), and M20/M21/M22 (a working self-drawn-cursor editing loop on live Typst
rendering — the "Live cursor" view) are all done, with M15's per-block swap mechanism
built three times, found fundamentally unworkable, and superseded by that same
self-drawn-cursor mechanism (see M15's entry for the design-principle correction this
forced — reflected in [design-principles.md](doc/design-principles.md) rule 2). M23
(porting Phase 2's table/toolbar affordances onto the new mechanism) was deprioritized
to backlog when Phase 3 closed — see [phase3-single-view.md](doc/phase3-single-view.md)
for that closing-time record — but was picked back up as part of Phase 4's real
implementation work rather than staying backlogged: it's substantially done now (table/
mark toggles, toolbar, Ctrl+B/I), tracked going forward in
[phase4-product-validation.md](doc/phase4-product-validation.md), not as a separate
Phase 3 item. A slash-command menu was part of M23's original scope but has since been
downgraded to "待确定" in [interaction-design.md](doc/interaction-design.md) §10 结论 20
— the reasoning that motivated wanting one (helping users avoid hand-typing syntax)
doesn't hold now that "zero syntax" was dropped as a goal.

## Current focus: Phase 4 — Product Validation

Full detail, including the milestone log and real-machine testing record, is in
[doc/phase4-product-validation.md](doc/phase4-product-validation.md). Summary: Phase 3
validated the *engineering* feasibility of single-view editing;
[doc/interaction-design.md](doc/interaction-design.md) (2026-09-09) is the product
design that followed, proposing **focus-reveals-source** (a focused block becomes a
native, editable source-text region; every other block stays fully rendered) as a
refinement of M20–M22's mechanism rather than a restart. Spikes 1–3 validated this is
the right direction, and it has since landed as the Live cursor view's real editing
mechanism — not just a spike anymore. Since then: cross-block undo/redo, Ctrl+B/I,
Up/Down cross-block navigation, reference-chain navigation, and M23's table/toolbar
port are all done and real-machine tested; autosave (§7) is done. Currently designing a
fallback for a confirmed bug where one compile error anywhere in the document blanks
Live cursor's entire rendering and navigation, not just the broken block (root cause:
`compile_typst`/`block_geometry` are both whole-document — see
[doc/phase4-product-validation.md](doc/phase4-product-validation.md) for the design in
progress). Still not started: independent user validation of true WYSIWYG as a real
pain point — the original, oldest item in §10's "待确定" table; two more have joined it
since (the slash-menu and autosave-mechanism choices), both judgment calls made without
user data, not yet validated either.
