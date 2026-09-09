# Phase 4 — Product Validation (in progress)

Product rationale: [interaction-design.md](interaction-design.md). Prior engineering
validation this builds on: [phase3-single-view.md](phase3-single-view.md).

## Focus

Phase 3 validated the *engineering* feasibility of single-view editing.
[interaction-design.md](interaction-design.md) (2026-09-09) is the product design that
follows: it drops "zero syntax" as a goal, retargets the primary user to Typst-literate
writers who want faster everyday input (not syntax-free novices), and proposes
**focus-reveals-source** as the core editing mechanism — a focused block becomes a
native, editable source-text region; every other block stays fully rendered. This
refines M20–M22's mechanism rather than restarting it: it reuses M14A's geometry work
and keeps cross-block selection on the self-drawn-cursor path, but moves single-block
typing off the per-keystroke whole-document recompile loop (M21) and onto native
browser text editing (free undo/redo, IME preview, copy/paste).

## Next steps (priority order)

Full rationale in [interaction-design.md](interaction-design.md) §10.

1. **Spike 1** — one paragraph: focus → native textarea shows source, blur → back to
   rendered. Validate the core swap feels right before building anything further.
2. **Spike 2** — Spike 1 plus an adjacent paragraph: validate the commit-and-handoff
   when a selection crosses a block boundary.
3. **Fact-check (parallel, low-cost)** — confirm Typst's blank-line paragraph-split
   rule holds inside list items and table cells (check the `typst-syntax` parser
   directly, not by analogy to Markdown/LaTeX).
4. **Spike 3** (later) — compare commit-on-blur vs. eager-split-on-blank-line for how
   a new block gets created while typing.
5. **User validation** (independent, parallel track) — interview real target users on
   whether "zero render drift" (editing always shows the real compiled result, not an
   approximation) is a pain point they actually feel; currently only supported by
   indirect evidence.

## Milestones

(none closed yet — Spike 1 is next, see above)
