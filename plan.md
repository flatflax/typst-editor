# Typst WYSIWYG Editor — Plan

## Status

| Phase | Milestones | Scope | Status |
|---|---|---|---|
| 1 — MVP | M0–M6 | Prove `Source ⇄ Editor Model ⇄ Typst` forms a stable, round-trippable closed loop | Complete |
| 2 — Content & File I/O | M7–M12 | File I/O, PDF export, links, tables, images/figures, toolbar/UI polish | Complete |
| 3 — Single-View WYSIWYG | M13–M23 | Collapse the editing surface and preview into one — the long-term product target | M13/M14/M14A/M15/M18 done (M14: partial-negative, M15: negative, M18: positive — see below); M20 next |

Details: [Phase 1 — MVP](doc/phase1-mvp.md) · [Phase 2 — Content & File I/O](doc/phase2-content-io.md) · [Phase 3 — Single-View WYSIWYG](doc/phase3-single-view.md) · [Architecture](doc/architecture.md) · [Design Principles](doc/design-principles.md)

## Product goal

A desktop Typst editor that edits like Typora or Notion — a single WYSIWYG view, no
separate preview pane — while every character is still backed by the real Typst
compiler, not an approximation. See [Phase 3](doc/phase3-single-view.md) for the
architecture that makes this tractable.

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
   Revised after M15 (below): cursor/selection for on-surface content is owned by
   Typst's own rendering, not split off into a separately-laid-out editing widget.

## Current focus: Phase 3

Full detail in [doc/phase3-single-view.md](doc/phase3-single-view.md).

- **M13 — done.** Refactored node-type dispatch (`spokes/markdown.ts`,
  `spokes/typstAst.ts`) onto a shared table + exhaustiveness checks — a prerequisite
  for adding more Typst content types cleanly.
- **Perf baseline (parallel, non-gating) — edit-position follow-up done (negative
  result); full pipeline instrumentation not started.** Full task: instrument the
  existing pipeline end-to-end (parse/convert/render/edit/serialize/compile/preview)
  across a sweep of fixture sizes, not just one file. Not a gate — doesn't block M14A+
  and can run any time; doubles as a regression guard for M14's linear-in-pages
  finding, and its tooling is meant to be reused by M14A/M15/M16's own perf checks.
  Its edit-position follow-up (below) is done: recompile cost tracks total document
  size, not proximity of the edit to the end — rules out a bounded-window recompile at
  the compile layer as a perf lever. See [doc/phase3-single-view.md](doc/phase3-single-view.md).
- **M14 — done, partial-negative.** Whole-doc recompile-after-edit scales ~linearly
  with page count, not page-count-independent — fast enough for short/medium
  documents, too slow for long ones, and `comemo` caching doesn't rescue it (Typst's
  pagination pass is inherently whole-document-sequential). Doesn't block M15, but
  M15/M16 must design around this cost. Measurements and consequences in
  [doc/phase3-single-view.md](doc/phase3-single-view.md).
- **M14A — done, positive.** `Frame` data (via `typst-ide`'s own span-matching
  mechanism, generalized from a point to a range) does cleanly yield page, x/y,
  width/height, and baseline; line boxes are reconstructed by clustering same-baseline
  glyph hits (`Frame` doesn't preserve a per-line boundary itself); fragment boxes for
  content pulled out of flow (footnotes) fall out for free. No coarse-bounding-box
  fallback needed. Prototype and limitations in
  [doc/phase3-single-view.md](doc/phase3-single-view.md) (`geometry.rs`).
- **M15 — done, negative result.** Per-block render/edit swap (PM node view
  showing either a rendered fragment or an editable view, toggled on
  focus/blur) was built three times — NodeView-based, absolute-positioned
  overlay, before/after crop — each fixing the previous attempt's failure but
  landing on a new one, down to a design-principle failure: cursor/selection
  can't be split across two independently-laid-out systems (PM/CSS and Typst)
  rendering the same region. Cancels M15b (extend the swap to table/image/list
  — no swap mechanism left to extend) and M17 (cursor continuity across swaps
  — nothing to be continuous across). Session-held `World` (`compile.rs`) is
  kept — load-bearing for M21, independent of the swap's fate. Full account,
  including the revised mechanism and design-principles.md rule 2's
  correction, in [doc/phase3-single-view.md](doc/phase3-single-view.md).
- **M18 — done, positive.** CJK IME composition spike. Tested manually against
  real Chinese/Japanese/Korean IMEs on `spike/m18-ime/index.html`: the
  full-replace-from-`compositionupdate.data` model holds for all three,
  including Japanese candidate-cycling and Korean's in-place jamo-to-syllable
  replacement; candidate-window positioning is correct in all three
  (confirmed visually); two harness bugs found and fixed (backspace-cancelled
  composition corrupting committed text, caret not tracking the composition's
  growing end). One finding to carry forward: Korean commits per-syllable, a
  real composition-event frequency difference from Chinese/Japanese, not a
  correctness gap. The one unvalidated risk the revised mechanism depended on
  is now cleared. Full account in
  [doc/phase3-single-view.md](doc/phase3-single-view.md).
- **M20 — not started, next.** Static cursor/selection/hit-testing directly on
  live Typst rendering, using M14A's geometry — no editing, no IME. First
  visible positive milestone since M12.
- **M21 — not started, depends on M18+M20.** Edit loop: keystroke → whole-
  document recompile (session `World`) → redraw SVG → redraw cursor from fresh
  geometry. No block-scoped/second-`World` compilation for v1.
- **M22 — not started (supersedes M16).** Settle-window UX and live reflow.
  M16's correctness question (stale sibling content) is resolved by
  construction under M21; only latency/visual-continuity UX remains.
- **M23 — not started.** Port Phase 2 editing affordances (tables, slash menu,
  toolbar, lists) onto a parse → transform → serialize model.
