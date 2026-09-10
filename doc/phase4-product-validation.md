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

1. ~~**Spike 1**~~ — done, positive; see Milestones below.
2. ~~**Spike 2**~~ — feel-tested and fixed live (width, staleness, page height, fair-share
   margins on both axes); see Milestones below.
3. **Fact-check (parallel, low-cost)** — confirm Typst's blank-line paragraph-split
   rule holds inside list items and table cells (check the `typst-syntax` parser
   directly, not by analogy to Markdown/LaTeX). Still open.
4. ~~**Spike 3**~~ — "lazy" (commit-on-blur) half implemented and verified; the "eager"
   comparison is still open. See Milestones below.
5. **User validation** (independent, parallel track) — interview real target users on
   whether "zero render drift" (editing always shows the real compiled result, not an
   approximation) is a pain point they actually feel; currently only supported by
   indirect evidence.

## Milestones

**Spike 1 — Focus reveals source: core swap (done, positive).** Built as an isolated
tab (`FocusRevealSpike.tsx`, not wired into `TypstLiveView`'s M20 caret machinery —
deliberately a throwaway swap of real DOM nodes, per this spike's own scope): a
rendered `<div>` showing the real compiled SVG on blur, a real `<textarea>` holding raw
source on focus, recompiled through the same `compile_typst` as every other view.
`source` only updates on blur/commit, never per keystroke, so typing itself never
touches the Typst compiler (§5D/§6's whole point).

Live-tested on real hardware, not just headless — three problems surfaced this way that
static review missed, all fixed before the swap read as right:

- **Width jump on focus.** The rendered state sits at the compiled page's own natural
  width — `typst_svg` output never stretches past that, however wide the window is. The
  textarea has no such intrinsic width; `width: 100%` fills the *entire* available
  column instead. On a 1080p fullscreen window that's page-width (~793px) snapping to
  full-window-width (~1800px) the instant you focus — confirmed with a headless
  Playwright measurement against the live dev server. Fixed by measuring the rendered
  `<svg>`'s actual width at focus time and locking the textarea to that exact pixel
  value, so the swap doesn't move the box at all. Also found and fixed along the way: a
  CSS Grid item's default `min-width: auto` can force the whole column (and page) wider
  to fit unwrapped textarea content — needs an explicit `min-width: 0` on the grid
  items, plus `overflow-wrap: anywhere` on the textarea so even a spaceless run doesn't
  demand extra width.
- **`el.select()` on focus is actively harmful.** Selecting the full draft to visually
  signal "you're in source mode" means the very next keystroke — Enter included —
  replaces the *entire* selection instead of extending it. Live-tested as "press Enter
  to add a line, type content, blur — nothing renders": the original paragraph had
  silently been replaced by just the new content, read as data loss rather than as
  addition. Fixed by landing the caret at the end of the text on focus instead.
- **Escape should not discard the draft.** An early version treated Escape as "cancel,"
  reverting to the pre-edit source — surprising given every other way of leaving the
  textarea (click away, Tab) commits normally, and nothing marks Escape as special.
  Fixed: Escape now just blurs, same commit path as anything else.

None of these three are specific to the "one paragraph" scope — they carry forward to
Spike 2/3 and any real implementation of §6's focus-reveals-source mechanism. With all
three fixed, the core swap itself — native textarea in, real Typst render out, on a
plain focus/blur — feels right.

**Spike 2 — Cross-block commit-and-handoff (implemented, mechanism verified; feel not
yet tested).** Two adjacent paragraphs (`FocusRevealSpike2.tsx`). Two rendering
strategies, swapped wholesale rather than mixed:

- **Combined** (nothing focused, the resting state): one real compile of the whole
  two-paragraph source, with a self-drawn selection overlay drawn via `block_geometry`
  — the same mechanism `TypstLiveView.tsx` (M20) already validated, reused as-is rather
  than reimplemented, scoped to this two-paragraph document.
- **Split** (one paragraph focused): the two paragraphs go back to being two
  independently-compiled, normal-document-flow siblings (Spike 1's approach, twice) —
  considered and rejected an absolutely-positioned textarea overlaid on the combined
  render instead, since a growing textarea would then overlap the next paragraph
  instead of pushing it down.

The handoff itself: a native drag started inside the focused textarea is watched (a
window-level `mousemove` listener checking the pointer against the textarea's own
bounding box) for the moment it leaves that box — exactly "the selection just crossed a
block boundary" (§6). At that instant: the focused block is committed, the native
selection's fixed end is converted to an absolute byte offset *against the freshly
committed source* (not an approximate mapping, matching §6's own wording), and the view
swaps to combined mode with that as the new anchor — the cursor starts collapsed for one
frame (the combined `<svg>` isn't mounted yet to convert the current pointer position
against) and extends normally on the next native mousemove once it is. Per §6's fourth
point, the mode is decided once at the boundary crossing and stays fixed for the rest of
that gesture, not re-decided as the pointer wanders back and forth.

Verified end-to-end with an automated Playwright drag simulation against the live dev
server (a deterministic mock backend standing in for `compile_typst`/`jump_from_click`/
`block_geometry`, since the real ones need a running Tauri session): click inside
paragraph A correctly enters split mode with exactly that paragraph's text in the
textarea; dragging past the textarea's bottom edge correctly commits it, hands off, and
produces a non-empty cross-block selection rect once the pointer reaches paragraph B;
the selection persists correctly after mouseup. One artifact surfaced by that test worth
flagging as an open risk rather than a confirmed bug: the mock's per-block SVGs don't
size consistently with its combined-document SVG, so a straight-line drag aimed at
"just past the old textarea's edge" briefly missed the newly-mounted combined view
entirely. The real Typst backend should keep block heights consistent between an
isolated compile and the same paragraph inside a combined compile (same page width/
margins both times) — but that consistency is an assumption, not yet confirmed against
the real compiler, and is exactly the kind of thing that could make the real handoff
feel like a visible jump even though the mechanism itself is correct. Feel-testing on
real hardware (per Spike 1's own lesson: static/automated review missed real problems
static review wouldn't have caught) is the next step before calling this one closed.

**Found and fixed during that same hands-on pass**: the "other" (unfocused) block's
isolated compile is one shared piece of state (`otherBlockSvg`) regardless of *which*
block currently occupies that role. Switching focus directly from block A to block B
(or re-entering split mode at all) didn't clear it first — so for one compile's worth of
real latency, the *previous* other block's markup stayed on screen, mislabeled as the
new one, before snapping to the correct (and generally differently-sized) content. An
instant-resolving test double never surfaces this (nothing to race against), but a
Playwright run against a deliberately-delayed mock reproduced it exactly, and confirmed
the fix (clear `otherBlockSvg` synchronously alongside every focus change) closes it —
this is very likely what read as "the textarea's Y position is weird" under the real
compiler's actual latency. Distinguished from M22's already-accepted staleness pattern
(the *combined* view showing last-settled content while a recompile is in flight is
fine — same document, just one edit behind); this was wrong content under the wrong
label, not merely stale content, which is why it needed fixing rather than leaving as
an accepted gap.

**A second, more fundamental issue, also found live and also read as "the textarea's Y
position is weird"**: compiling a single paragraph completely alone — as both Spike 1's
own `source` and Spike 2's isolated "other block" compile do, with no `#set page`
override — gets Typst's *default full page height* (A4-ish), not a tight crop around
the one line of actual text. Confirmed via temporary instrumentation (logged every
layout transition's `getBoundingClientRect()` to the console, since opening DevTools
itself would blur — and thereby unmount — the very textarea being inspected): the
sibling isolated-block render legitimately measured ~950px tall (its real rendered width
÷ A4's aspect ratio), correctly pushing the focused textarea that far down the page in
normal document flow. Not a positioning bug at all — the textarea was exactly where
flow layout put it; the *sibling* was the one sized wrong. Fixed by prepending
`#set page(height: auto)` to the source for every isolated single-block compile (Spike
1's own, and Spike 2's other-block effect) — compile-only, never touching the real
committed text — so Typst shrink-wraps the page to its content instead. Left the
*combined* compile unwrapped, since that one is meant to represent the real multi-
paragraph document's natural pagination. Verified via Playwright that the wrapper reaches
exactly (and only) the two isolated-compile call sites, not the combined one.

**Third pass — replaced the isolated other-block compile entirely, not just patched
it.** Even after the `height: auto` fix, the other block's independent compile could
still visibly drift from how that paragraph looks inside the real combined document —
a *second* compile has no inherent reason to agree with the first on anything not
explicitly forced to match (width, margins, apparent scale — this was reported as "the
paragraph looks smaller"). Considered two alternatives before settling on a fix:

- Rendering the editing surface from Typst's HTML export instead of SVG, so the focused
  block could be real reflowing DOM throughout. Ruled out after checking Typst's own
  docs: HTML export is explicitly a *structural*, not *visual*, target — "Typst
  currently does not output CSS style sheets" and the format "cannot always know what
  the best semantic HTML representation of your content is" (typst.app/docs/reference/
  html/). Using it here would reintroduce exactly the "second engine approximating the
  real result" problem §4 identifies as the thing this project exists to avoid — not a
  maturity gap that will resolve later, a difference in what the export is *for*.
- Overlaying the textarea in-place on the combined render, accepting temporary overlap
  with the next paragraph while typing (reasoned as similar to Google Docs/Figma text
  box behavior). Checked that assumption before building on it and it didn't hold:
  Google Docs body text reflows live, every keystroke, and its own community forums
  report "overlapping text" as a bug, not a feature; Figma's own guidance is "avoid
  fixed-size text layers" specifically because they cause this overlap. No real editor
  treats "type past the box, temporarily cover the neighbor, fix on blur" as acceptable
  UX — it reads as broken, which is worse than a size mismatch.

Settled on: keep the other block as its own real DOM sibling (so the reflow-on-grow
property that ruled out the overlay stays), but stop compiling it independently.
Instead, crop it vertically out of the *same* combined SVG already being compiled for
the "nothing focused" state — query that block's own line-box geometry via
`block_geometry` (already used for cross-block selection highlights, no new backend
call), take the union of the returned boxes for its vertical extent, and rewrite the
combined SVG's `viewBox`/`height` to that band, leaving width untouched. Same rendered
pixels either way, by construction — not two renderers whose agreement has to be
independently verified and re-verified after every unrelated change. Verified via
Playwright: `compile_typst` call count is unchanged when entering split mode (confirming
no second compile fires at all), and the cropped markup carries the same inner content
as the combined SVG with only `viewBox`/`height` rewritten to the target block's band.

This generalizes past two blocks without new architecture: for N paragraphs, split mode
is still one real textarea plus N−1 cropped siblings, `block_geometry` already accepts a
batch of ranges in one round trip regardless of N, and nothing above needs the block
count fixed at compile-time. What does *not* generalize — and is explicitly out of both
Spike 1 and Spike 2's scope, deferred to Spike 3 — is the document's own block count
changing mid-edit (a blank line typed inside a focused block, splitting it into two
paragraphs once committed); both the old isolated-compile approach and this crop
approach are equally unable to answer that on their own.

**Fourth pass — the crop itself was too tight.** The first version cropped exactly to
the union of a block's own line boxes — correct in that it's the same pixels as the
combined view, but it discarded the page's own top/bottom margins for the edge blocks
and the natural gap between paragraphs entirely, reading as paragraphs crammed directly
against each other rather than reproducing the spacing they actually have. Fixed by
giving each block its "fair share" of the page's vertical space instead of just its own
ink's bounds (`fairShareBounds`): the first block's crop extends up to the real page
top, the last block's down to the real page bottom, and the boundary between two
adjacent blocks sits at the midpoint of the gap between them. Needs both neighboring
blocks' geometry (not just the one being cropped) to compute that midpoint — still one
batched `block_geometry` call, not two. Verified via Playwright with a mock whose
paragraph ink deliberately sits away from the page edges (simulating real margins): the
first block's crop starts at the true page top rather than its own first line, and the
last block's crop extends to the true page bottom rather than its own last line, with
the shared boundary landing exactly at the midpoint between the two paragraphs' ink.

**Fifth pass — the fair-share fix only reached the cropped sibling, not the focused
block itself.** Focus paragraph A specifically and its own leading page-top margin
still vanished — because A, once focused, is a bare `<textarea>` with none of that
page-margin spacing; `fairShareBounds` had only ever been applied to whichever block
*wasn't* focused. Fixed by computing the same margin for the focused block too — its
own ink range vs. its own fair-share bounds — and applying the difference as real CSS
`margin-top`/`margin-bottom` on the textarea (not padding: the gap should read as blank
page, not as part of the yellow "source mode" surface). Needed a pt-to-px scale factor
(the locked width in px ÷ the page width in pt) since this margin is computed in pt
alongside the crop geometry but applied as a CSS pixel value. Verified via Playwright:
focusing the first paragraph now gets a `margin-top` matching its real leading gap and a
`margin-bottom` matching half the inter-paragraph gap; focusing the last paragraph gets
the mirror image (small top margin, large bottom margin down to the true page bottom) —
both cases matched the expected ratios exactly.

**Sixth pass — same problem, horizontal axis.** The textarea's width was locked to the
*full page width* edge-to-edge (only ~4px of CSS padding), so its text starts/ends well
outside where that same text's left/right content margins actually sit in the rendered
view. Fixed the same way as the vertical case: pooled both blocks' line boxes together
(not just the focused one's — a single short paragraph's own lines might never reach the
true right margin on their own) to get the page's real left/right content extent, then
narrowed the textarea's width to that content width and applied the leftover space as
`margin-left`/`margin-right`. Verified via Playwright with mock content margins on both
sides: width and both margins came back in exactly the expected ratio to the page width.

**Noted, not yet fixed**: a brief visual flash during the mode transition itself (clicking
to focus/switch blocks) — not yet investigated, recorded here so it isn't lost before the
next pass at this spike.

**Spike 3 — "lazy" block-count-change on commit (lazy half implemented and verified;
"eager" comparison still open).** interaction-design.md §6 offers two options for how a
new block gets created while typing — "lazy" (freely type anything, including blank
lines, and only reparse into however many blocks that produces at blur) and "eager"
(split off each completed paragraph the instant its blank line appears, keep typing the
remainder, reuse M22's optimistic-pending visual for the just-split-off part). The doc's
own priority order says try lazy first; this pass builds only that half.

`FocusRevealSpike3.tsx` builds directly on Spike 2's architecture (combined/split
rendering, crop-based unfocused siblings, fair-share margins on both axes) but
generalizes the one thing Spike 2 hardcoded: exactly two blocks, split once at the first
blank line. Here `blockByteRanges` splits on *every* blank-line boundary and is always
recomputed fresh from `source` — never trusted as a remembered count — because that
recompute, at commit time, is the entire mechanic under test.

One consequence needed real handling, not just widening a type from `0 | 1` to `number`:
clicking a sibling block directly (`switchFocusTo`) while the currently-focused block is
about to expand into several can shift that sibling's *index* out from under it. Fixed by
relocating the sibling by byte position instead of index: capture where it started before
the commit, shift that position by the focused block's own length delta (only if the
sibling came after it), then find whichever freshly-recomputed block now contains that
position — not the block that used to be at slot N.

Verified via Playwright against the live dev server (a mock backend, geometry model as
in Spike 1/2's own verification): focused one paragraph, replaced its content with two
halves separated by a blank line, blurred via Escape (confirming Escape's earlier fix —
commit, not discard — matters here too), and confirmed clicking each half afterward
resolves to exactly that half's own text, not the original combined block. Separately
verified the index-shift case: edited a focused block to contain a blank line *without*
blurring, then clicked directly on a sibling that was rendered at what was about to
become a stale index — it correctly resolved to that sibling's real, unaffected content
rather than the wrong (shifted) block.

**Not yet done**: feel-testing on real hardware (does the reparse-at-commit read as
natural, or does the sudden appearance of a new block feel jarring); the "eager"
alternative, to actually compare against; and the fact-check on whether Typst's
blank-line rule holds inside list items/table cells (§10's own open item, unaffected by
which of lazy/eager wins — both would need it before covering that content).
