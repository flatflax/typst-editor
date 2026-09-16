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
3. ~~**Fact-check**~~ — done: blank line safely ends a list item (matches our splitting
   assumption), but does *not* end a table cell, and `blockByteRanges` used to split there
   anyway. Confirmed architectural gap, fixed by making the split bracket-depth-aware
   (`src/editor/blockSplit.ts`) — see Milestones below.
4. ~~**Spike 3**~~ — both "lazy" and "eager" halves implemented, verified, and feel-tested
   against each other; lazy wins (eager flickers on every paragraph split during continuous
   typing). See Milestones below.
5. **User validation** (independent, parallel track) — interview real target users on
   whether **true WYSIWYG** (editing always shows the real compiled result, not an
   approximation — the industry's own term for this specific property, per
   interaction-design.md §4/footnote; this doc used to call it "zero render drift," a
   made-up term now retired) is a pain point they actually feel; currently only
   supported by indirect evidence.
6. ~~**Land the core mechanism as a real implementation**~~ — done (2026-09-11), scoped
   narrowly per direct confirmation: `TypstLiveView.tsx` (not a new/parallel component —
   see its own "Landed as a real implementation" entry below for why) now has a block
   model, and a block whose cursor/selection collapses fully inside it becomes a real
   `<textarea>`. Real-machine testing (below) found and fixed two real problems (a
   flex-shrink layout bug; slow, whole-document-scanning focus-entry/switch on a real
   multi-page document) — everything else it covered passed.
6a. ~~**M23 toolbar integration with a focused block**~~ — done (2026-09-11): a toolbar
   command's result now lands back inside the same textarea (not combined mode), per
   direct confirmation. Found and fixed three related bugs along the way — a keyboard-driven
   selection collapse (arrow keys) leaving a stray self-drawn caret instead of focusing a
   block; a more fundamental one it depended on (a handoff-created cross-block
   selection left *no* element focused at all, so no keyboard interaction worked for it);
   and, found only once real-machine testing exercised a mark-toggle command against a
   selection, a UTF-16-vs-UTF-8-byte-offset bug in the shared PM-position map
   (`spokes/typstAst.ts`, pre-existing, not introduced by this pass) that misapplied the
   command to a shifted range whenever a multi-byte character appeared earlier in the
   document. Deferred at the time, not silently dropped, both now done (2026-09-15, see
   Milestones below): Up/Down navigation across a block boundary; reference-chain navigation
   UI for `#let`/`#import` bindings and `<label>`/`@ref` cross-references (interaction-design.md
   §10 结论 14) — `#set` rule influence tracking specifically stays out of scope, a genuinely
   different, harder problem (see Milestones). This closes out every item from this list.
7. ~~**Backend algorithmic fix for `geometry_for_range`**~~ — done (2026-09-14, promoted
   from "someday" given real-machine testing on a multi-page document, 2026-09-11): added
   `geometry_for_ranges`, which walks each page's frame tree once for every requested range
   together and buckets glyphs into whichever target range they fall in, instead of walking
   the whole tree once per requested range. See Milestones below.
8. ~~**Cross-block undo/redo**~~ — implemented (2026-09-15), the P0 gap
   interaction-design.md §8 called out (Live cursor had no app-level history at all — Ctrl+Z
   only worked via native per-textarea history for one focused block's one visit). Real-machine
   testing across two rounds (2026-09-15/16) found and fixed four real bugs — two focus-loss
   bugs, unwanted no-op history entries, and stale history surviving a File → Open onto a
   different document. See Milestones below. A final re-verification pass on the latest fixes
   is still pending at time of writing.

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
(Superseded by the "Third pass" below: the isolated other-block compile this assumption
was about got removed entirely, not merely confirmed.)

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
next pass at this spike. (Resolved by the entering-focus-stutter fix under the Spike 3
cross-block feel-test below.)

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

**Found and fixed during that same pass, in both Spike 2 and Spike 3**: clicking sometimes
resolved to the wrong paragraph. Root cause was the same class of bug M23 already found and
fixed in `TypstLiveView.tsx`, just never ported to these two spikes: a click's pixel
coordinates come from whatever SVG is *currently rendered*, but `jump_from_click` resolves
them against the *current* `source` — right after any commit, for one round trip, those two
can disagree (stale pixels, fresh document), silently landing on the wrong text. The same
mismatch corrupts a cropped sibling too (stale pixels + fresh geometry coordinates cut the
wrong band out of the old image). Not a caching bug in the ordinary sense. Fixed by porting
M23's own fix: an `isPending` flag (true the instant `source` changes, false once the
displayed SVG catches up) that makes click resolution refuse to run, and cropping fall back
to a "Compiling…" placeholder, until the two are back in sync. Verified via Playwright
against a deliberately-delayed mock: confirmed the bug reproduces with the guard removed
(a pending-window click both fired `jump_from_click` and corrupted the view), and disappears
with it restored (the click is silently ignored until the compile lands, then works
normally).

**Spike 3 (eager) — implemented and verified.** `FocusRevealSpike3Eager.tsx`: the instant a
complete blank-line separator appears in the focused draft (checked on every `onChange`, not
waiting for blur), the completed part splices into `source` immediately and the textarea
keeps only the remainder as its live value — reusing the `isPending` mechanism above for
free to show the freshly-split block as "Compiling…" until it actually renders, which is
exactly M22's optimistic-pending convention applied here rather than built again from
scratch. Cursor handling needed no manual DOM work either: bumping `focusedBlock` by however
many blocks the split produced means the array position that now holds `<textarea>` was a
different element type a moment ago, so React's own keyed reconciliation unmounts/remounts
it with `defaultValue` already set to the trimmed remainder, and the existing
focus/cursor-placement effect (already needed for plain click-to-focus) runs again for free.
Verified via Playwright: typing content containing a blank line *without blurring* correctly
trims the live textarea to just the tail, and the completed part is independently
addressable (as its own committed block) immediately, no blur required.

**Found and fixed live, in the eager variant specifically**: editing the first paragraph
could silently overwrite the *next* paragraph's content. Root cause: the eager split fires
the moment a blank-line separator is typed, before anything follows it — so the freshly-
split-off "new paragraph" is still empty at that instant. Splicing `completed + "\n\n" + ""`
back into `source` puts that empty paragraph directly against whatever separator already
followed the old block, producing a run of 4+ consecutive newlines. Typst collapses any run
of blank lines into a single paragraph break (this spike's own `blockByteRanges` mirrors that
with a greedy `\n{2,}` regex), so the "empty paragraph" was never actually a distinct block
at all — it silently merged with the real paragraph after it. `focusedBlock` still pointed at
that (now-merged) slot, so the textarea ended up editing the *next real paragraph's* byte
range, and committing overwrote it. Fixed by not splitting until `remaining` has at least one
non-whitespace character — guarantees the split always produces a genuinely distinct block,
never an empty one that Typst (and this function's own regex) wouldn't recognize as separate.
Verified via Playwright: with the fix, typing a blank line with nothing after it yet leaves
the textarea showing the full undivided text (no premature split); typing real content after
it then splits correctly; and the original next paragraph's text is confirmed byte-for-byte
intact after commit. Confirmed the fix is load-bearing by disabling it and reproducing the
premature split.

**Conclusion (2026-09-10)**: hands-on comparison of both variants settled it — lazy feels
better. Eager's cost is a flicker on every paragraph completion during continuous typing: each
time a blank line completes, `isPending` (correctly) forces all non-focused sibling blocks back
into their "Compiling…" placeholder until the next compile lands, so a long block-splitting
paragraph produces repeated flicker before the user has even paused. Lazy only makes that same
transition once, at the natural pause point of blur, so it never interrupts mid-sentence. This
isn't a bug in the eager implementation — the pending-guard is doing exactly what it's supposed
to — it's an inherent cost of splitting eagerly at all: more splits during a single continuous
edit means more flicker. `FocusRevealSpike3Eager.tsx` stays in the repo as a validated-but-not-
adopted alternative; no further polish is planned for it. See interaction-design.md §10 item 13.

**Fact-check done (2026-09-10): Typst's blank-line rule does *not* hold uniformly.** Tested
directly against the real compiler (not a mock): a blank line inside a list item's body ends
the list — the content after it becomes a new top-level paragraph outside the list, matching
this spike's own `\n{2,}`-splits-everything assumption (safe). But a blank line inside a table
cell (`#table(...)`'s `[...]` argument) stays inside that cell — it does *not* end anything.
`blockByteRanges`, which only pattern-matched `\n{2,}` textually with no idea it's sitting
inside a bracketed argument, still split there anyway. Confirmed live: clicking into that
cell's content showed the wrong text in the textarea (content from *above* the table), because
the byte range this produced didn't correspond to any real top-level block.

**Fixed (2026-09-10)**: extracted `blockByteRanges`/`blockAt` out of the spike components into
their own module, `src/editor/blockSplit.ts`, and rewrote the splitter as a single linear scan
that tracks `(`/`[`/`{` nesting depth (not distinguishing bracket type — a working document
never mismatches them, and a temporarily-unbalanced one mid-edit is safer to under-count toward
*more* splitting than to get permanently stuck above depth 0) and only treats `\n{2,}` as a
split point at depth 0. String literals, single-backtick raw spans, and line/block comments are
skipped while scanning so bracket-like characters inside them (`"(unbalanced"`, `` `foo(bar]` ``,
`// see [ref]`) don't distort the count. Covered by 13 unit tests in `blockSplit.test.ts`
(exercising exactly the two fact-checked scenarios above, plus `#figure[...]`, the
string/comment/raw-span edge cases, and CJK byte-offset correctness) — no live app or mocked
Tauri backend needed, since this is pure text logic. `FocusRevealSpike3.tsx` now imports from
this module instead of keeping its own copy; re-verified end to end via Playwright that
ordinary plain-paragraph splitting still works unchanged after the swap. **Known, small,
accepted gap**: triple-backtick raw *fences* aren't tracked as a single span, so a bracket
inside a fenced code sample could still distort the depth count — not hit by either fact-
checked scenario, worth revisiting if fenced code examples become common content. Spike 2 and
the (unadopted) eager variant were *not* updated to use the new module — Spike 2 is superseded
by Spike 3, and the project's own conclusion on eager (see the lazy-vs-eager entry above) is
that it gets no further polish. See interaction-design.md §10.

**Cross-block feel-test (2026-09-10), on Spike 3 lazy — two findings, both found live and
fixed same day:**

1. **Entering focus visibly stuttered; exiting didn't**, even though both involve a
   comparable height change (rendered line height vs. textarea line height differ
   substantially). Root cause, confirmed by reading `enterSplitMode`/the old
   `focusedBlockLayoutPx` effect: entering focus was a *two-step* reveal —
   `setFocusedBlock(idx)` fired immediately, rendering the textarea with only its locked
   width (no computed margins yet) and all sibling blocks as "Compiling…" placeholders;
   only once the `block_geometry` round trip to Rust resolved (a second, later render) did
   the real margins/crops land. Exiting didn't have this problem because `commitEdit` just
   flips back to combined mode showing whatever `combinedSvg` already is (stale but
   complete) — one clean swap, no intermediate no-margin/placeholder frame. **Fixed** by
   extracting the geometry computation into `computeSplitLayout` and `await`-ing it in both
   `enterSplitMode` and `switchFocusTo` *before* touching any state, then setting
   `focusedBlock`/`otherBlocksYRanges`/`focusedBlockLayoutPx` together in one go — the
   reactive `useEffect` that used to do this after the fact is gone, so there's no longer a
   window where split mode is showing with the wrong (or no) layout. Not an inherent cost of
   the mechanism — an ordering bug.
2. **Dragging out of the focused textarea to start a cross-block selection didn't produce a
   visible selection — it just looked like the textarea closed, and reopened on mouseup.**

   **First diagnosis (wrong)**: suspected `handoffToCombined` committing the draft flipped
   `isPending` true for the rest of the drag, and a real compile round trip usually outlasts
   the gesture, so the mouse went up with cursor still equal to anchor before `isPending`
   ever cleared. Fixed with an `ignorePending` bypass scoped to the handoff-continued drag,
   verified via Playwright against a mock with an artificial `compile_typst` delay — the
   symptom reproduced with the bypass disabled and disappeared with it restored. **This
   "verification" was misleading**: real hands-on testing in the actual app (`pnpm tauri
   dev`, real Typst compiles) showed the exact same failure, bypass and all. Live debug
   logging (temporarily added to `offsetAtClient`, `handoffToCombined`, the window
   mouse-move/up listeners) showed `isPending` was `false` the entire time — the guard was
   never even the blocker. `jump_from_click` was being called with plausible-looking
   coordinates and legitimately returning `null` for every sample.

   **Real root cause**: the native `<textarea>` (browser font/line-height) and the combined
   mode's real Typst SVG render the *same text* at different heights — the same mismatch
   already flagged informally in the very first round of Spike testing ("a flicker during the
   focus/blur transition", "should the textarea's edges align with the paragraph being
   edited"). The old implementation switched into combined mode
   *mid-gesture*, the instant the mouse left the textarea, and kept re-resolving the mouse's
   screen position against the combined SVG on every subsequent mousemove. Each resolution
   had to translate a screen position that was calibrated against the textarea's (taller)
   layout into the SVG's (shorter, real) coordinate space — so a drag that visually still
   looked like it was inside block B's text had, numerically, already passed the last real
   glyph into blank page space, where `jump_from_click_in_frame` correctly (and permanently,
   for the rest of that gesture) returns no target.

   **Real fix**: this also turned out to be a case of not following interaction-design.md §6's
   own stated principle — "which mode a drag/shift-select gesture is in is decided once, at
   the gesture's end, not switched back and forth mid-gesture" — which the mid-drag handoff
   violated. Rewrote it to match: while the mouse is outside the textarea mid-drag, nothing
   updates live (the native textarea does whatever a browser does in that situation, no JS
   involved); only on `mouseup` does the gesture commit the draft and resolve a *single* final
   position, once every sign that commit has actually landed agrees (`focusedBlock === null`,
   `source` equals the exact string just committed, and `!isPending` — checked together
   declaratively, since `isPending` flipping true is itself a separate, later effect off
   `source` changing, so it can't be trusted alone immediately after the commit). One
   cross-coordinate-system resolution per gesture, against one fully-settled render, instead
   of dozens against a moving target — removing the drift, not papering over it.

Both #1 and #2 were re-verified via Playwright against mocks with artificial delays (on
`block_geometry` for #1, `compile_typst` for #2): each symptom reproduces with its fix
disabled and disappears with it restored. #2's fix was additionally confirmed by hand in the
real app (three rounds of live debugging with temporary console logging, since the Playwright
mock's simplistic layout model never actually reproduced the real font-metric mismatch that
was the true cause) — dragging across a block boundary now shows no live update while the
mouse is outside the textarea (expected), and the cross-block selection appears quickly and
accurately the instant the mouse is released. See interaction-design.md §10 item 16.

**Landed as a real implementation (2026-09-11), not a spike — the mechanism itself, scoped
narrowly.** Confirmed with the user beforehand: land the core mechanism now, defer M23
toolbar integration, multi-page documents, Up/Down cross-block navigation, and
reference-chain navigation UI to follow-up work rather than bundling everything into one
pass.

**Where this landed, and why not a new/parallel component**: the plan going in left "extend
`TypstLiveView.tsx` in place, or build a new component reusing its combined-mode logic" as an
implementation-time call. Reading all 754 lines of it settled it: its *existing* M20
mechanism (self-drawn cursor/selection, click/drag hit-testing, IME via a hidden textarea,
diagnostics) is already exactly "the whole document is one big block with nothing else
focused" — building a second, parallel version of that same logic in a new file to serve as
the "nothing focused" state would have been pure duplication of code that already works,
not a meaningfully safer path. So `TypstLiveView.tsx` was extended in place: `focusedBlock`
state (`blockSplit.ts`) narrows what its *existing* mechanism is responsible for down to a
genuine cross-block selection (or nothing yet) — a plain collapsed click, which used to just
position a self-drawn caret, now resolves into focusing whichever block it landed in
instead (confirmed with the user: any click that resolves to a single position should focus
a block immediately, matching interaction-design.md §6's own wording, not require a second
action). Split-mode itself (native textarea for the focused block, fair-share-cropped
siblings, lazy commit-on-blur, the corrected mouseup-only cross-block drag) is ported
directly from `FocusRevealSpike3.tsx`.

**One deviation from the plan worth being explicit about**: the plan's own verification
section called for landing this as a *new* tab first, so it could be compared side by side
against the existing behavior before anything was replaced — precisely because extending
`TypstLiveView.tsx` in place, as this did, means there is no longer a separate "old flat
editor" tab in the running app to compare against directly. That tradeoff was made
deliberately (see the reuse rationale above), but it does mean the promised side-by-side
comparison isn't available the way the plan described it — real-machine testing (below) is
this landing's *only* verification against real usage, not a second opinion against a
known-good baseline still running alongside it.

**New shared, unit-tested module**: `src/editor/splitLayout.ts` (+ 15 tests in
`splitLayout.test.ts`) — the fair-share/crop/scale math extracted out of
`FocusRevealSpike3.tsx`, mirroring how `blockSplit.ts` was already extracted from the same
spike. `FocusRevealSpike3.tsx` itself was updated to import from this module too (removing
its own now-duplicate inline copy) rather than leaving two copies of the same logic to drift
apart — the same motivation as extracting it in the first place.

**M23 toolbar**: hidden (not shown, not merely disabled) while any block is focused, since
its commands operate on `cursorOffset`/`anchorOffset` across the whole document and aren't
yet integrated with a focused block's own uncommitted draft — confirmed with the user as the
simplest safe choice for this pass rather than risking a command applying against a stale or
wrong range.

**Verified so far**: `npx tsc --noEmit` and the full `npx vitest run` suite (269 tests, all
passing) after every meaningful step. Two Playwright-against-mock smoke tests against the
real `TypstLiveView` (not the spike) on the live dev server, reusing the same mock-backend
pattern as every spike test this session: (1) clicking a paragraph enters focus with the
toolbar hidden, typing content containing a blank line and blurring correctly splits it into
two independently-addressable blocks, and the toolbar reappears back in combined mode; (2) a
drag started inside a focused block's textarea and released past its boundary, with an
artificial `compile_typst` delay, produces a real cross-block selection on mouseup rather
than silently reopening the textarea — the exact bug pattern found and fixed today.

**Not yet done, and important**: real-machine testing in `pnpm tauri dev`, by the user,
specifically covering the items this pass's own plan flagged as needing it — a genuinely
long, multi-page document (the one point flagged as a real, untested risk, not just an
unstarted task); IME composition and undo/redo inside a focused block; and re-confirming
today's two fixed bugs (focus-entry stutter, cross-block drag-select) on this real
component rather than the throwaway spike. Nothing here has been committed pending that.

**Real-machine testing (2026-09-11) — items 1, 3, 4, 5 above passed. Two real problems
found on item 2 (the multi-page fixture), both fixed the same day.**

**Found and fixed: a focused block's textarea rendered squashed to less than one line
tall.** Root cause: `.typst-live-view` is a `flex-direction: column` container (unlike the
spikes' own plain-block wrapper, `.spike-focus-reveal`) — a flex item's default
`flex-shrink: 1` lets it be squeezed *below* its own content size (even below an
explicitly-set inline height, since that only sets the flex-basis, not a floor) whenever
the column's total children exceed the container's fixed `height: 100%`. The JS autosize
was computing the right height correctly the whole time; flexbox was shrinking the
rendered result underneath it. Confirmed with a real layout measurement (not just the
inline style, since that's exactly where the two diverged): reproduced by temporarily
forcing an ancestor short enough to trigger the shrink, with the fix removed;
`getBoundingClientRect().height` came back far below the autosized value. **Fixed** by
adding `flex-shrink: 0` to `.typst-live-block-textarea` and `.typst-live-block-rendered`
in `App.css`, confirmed to resolve it under the same forced-overflow condition. Related,
not fixed (not reported, out of scope for now): the same mechanism could in principle
squeeze the combined-mode SVG view (`.typst-live-stage`) too, if the window is small/
content tall enough — pre-existing, not introduced by this pass.

**Found: entering/switching focus on a real multi-page document (the `m21-multipage-test.typ`
fixture, `test-fixtures/`) was slow, and every other block sat on "Compiling…" long after
that.** Root cause, confirmed by reading the Rust source rather than guessed:
`block_geometry`'s own `typst::compile` call *is* comemo-cached as intended (near-free on
unchanged content) — the actual cost is `geometry_for_range` (`src-tauri/src/geometry.rs`),
called once per requested range, which walks *every page's every glyph* checking
range-membership regardless of how narrow that range is. `computeSplitLayout` (as it
existed before this fix) requested every block's range in one `block_geometry` call on
every focus-entry/switch — for an N-block document that's N full-document glyph walks in
one round trip, an O(blocks × total glyphs) cost that scales badly with real document
size, confirmed live on the 20-section/~80-block fixture. "Compiling…" on every other
block was a direct symptom, not a separate bug: `otherBlocksYRanges` simply couldn't
populate until that whole expensive call returned.

Four mitigations were weighed, specifically for the "editing repeatedly across many
different locations in a large document" workload (not just read-only navigation), since
that changes which one actually helps:
- **Caching the whole-document result per `source`** — nearly useless for this workload:
  every edit changes `source`, invalidating the cache immediately, so it never gets reused
  between edits. Only helps a click-around-without-editing pattern. Not done.
- **A small "focused block + immediate neighbors" fetch, with the rest backfilled in one
  background call** — keeps focus-entry fast regardless of document size, but the
  background call still eventually costs the same O(blocks × glyphs) as before, just moved
  off the interactive path; for a genuinely huge document doing many edits, this cost
  recurs after *every* edit regardless of what the user actually looks at.
- **True lazy, visibility-driven fetching** (adopted, see below) — a block's geometry is
  only ever fetched once it actually scrolls into view; cost scales with what's visible,
  not with document size or edit count, which matters more the larger the document and the
  more scattered the edits are.
- **A backend algorithmic fix** — invert `geometry_for_range`'s loop (walk the frame tree
  *once*, bucket each glyph into whichever of the sorted target ranges it falls in, instead
  of walking the whole tree once per range) to cut the *fundamental* per-call cost for
  every caller, not just this one. The most valuable fix for an edit-heavy-across-many-
  locations workload specifically (caching can't help there since `source` keeps changing,
  so raw per-call cost dominates), but it's a change to core M14A/M20 geometry-extraction
  code with real risk and testing surface — **not done this pass, promoted to the next
  task** rather than left as a someday-idea.

**Fixed**: `fairShareBoundsFromInk`/`widenContentBounds`/`focusedLayoutPxFromInk`
(`src/editor/splitLayout.ts`, +8 unit tests) are sparse-input equivalents of the existing
`fairShareBoundsForIndex`/`computeSplitLayoutFromBoxes` — computing a block's fair share
from whatever neighbor ink is *known so far* rather than requiring the whole document's
geometry up front, and distinguishing "neighbor not fetched yet" (wait) from "no such
neighbor, genuine document edge" (resolve using the page edge, same as before) via an
explicit `totalBlocks` bound rather than conflating both cases as "undefined" in a sparse
map. `TypstLiveView.tsx`'s `enterFocus`/`switchFocusTo` now fetch only `[idx-1, idx,
idx+1]` before flipping into split mode (small and bounded regardless of document size —
preserves the earlier entry-stutter fix's "resolve geometry before any state change"
discipline, just over a cheap request instead of an expensive one); every other block is
backfilled the instant it actually scrolls into view via one long-lived
`IntersectionObserver` (`registerBlockElement`/`ensureBlockObserver`), not proactively for
the whole document. A block whose real crop can't be shown yet keeps showing "Compiling…"
exactly as before — this changes *when* that resolves, not the placeholder mechanism
itself. Cache (`blockInkRangesRef`, keyed by `source`) is invalidated on any edit, clearing
`otherBlocksYRanges` to placeholder rather than leaving stale (pre-edit) crops displayed.

**Known, disclosed limitation, not fixed**: a block that stays continuously visible across
an edit made elsewhere won't refresh until it's scrolled out and back into view (or until
focus/switch happens to touch it as a neighbor) — `IntersectionObserver` only fires on a
visibility *change*, and this pass doesn't re-trigger it for already-visible elements after
an edit invalidates their cached position. Never shows *wrong* data (worst case, a
correctly-cleared "Compiling…" placeholder lingering longer than ideal), just occasionally
more conservative than necessary. Acceptable tradeoff for this pass given the added
complexity of tracking "currently visible" separately from "has been fetched"; revisit if
it turns out to matter in practice.

Verified via Playwright against a synthetic 40-block document (built by focusing a block
and pasting 40 paragraphs into it, then re-focusing): logged every `block_geometry` call's
requested-range count — focus-entry produced several calls of 1-2 ranges each (the
IntersectionObserver firing for on-screen siblings), never the whole 40; scrolling the
container to the bottom afterward increased the resolved (non-placeholder) block count
from 8 to 20, confirming blocks actually do backfill progressively as they're scrolled
into view rather than sitting on "Compiling…" indefinitely or all resolving in one shot.

**M23 toolbar integrated with a focused block (2026-09-11).** Previously hidden while any
block was focused (this milestone's own initial scoping decision). `runToolbarCommand`
still runs the same whole-document parse → PM-transform → serialize round trip
(`structuralCommand.ts`) it always did — a structural change like "toggle heading" needs
surrounding document context (list nesting, table structure) a single block's text can't
answer alone — but confirmed with the user that the *visible* result should land back
inside the same textarea, not bounce out to combined mode first. Implementation: if a
block is focused, its draft is committed and the native textarea's own
`selectionStart`/`selectionEnd` converted to absolute document byte offsets *before*
running the command chain; after it resolves, whichever block the result's cursor now
falls in (usually, but not necessarily, the same index) is (re-)focused with the new
content already showing. Needed two small supporting pieces:
- `pendingCursorUtf16Ref`: where the caret should land the next time a block is
  (re-)focused, in UTF-16 units within that block's own draft — `null` means "the end"
  (every ordinary click-to-focus path's existing behavior, unchanged). Without this, a
  structural command's result would always show the caret at the tail of the paragraph
  regardless of where the edit actually happened.
- `focusGeneration`: bumped on every (re-)focus, folded into the focused textarea's React
  `key` (`` `${idx}-${focusGeneration}` ``). Needed because a toolbar command can leave the
  *same* block index focused (its content changed, not which block it is) — without
  forcing a remount, React wouldn't pick up the new `defaultValue`, since an uncontrolled
  input's `defaultValue` is only read on mount.
- `handedOffRef.current = true` before swapping in the new content — same reasoning as
  the cross-block drag fix earlier in this doc: removing the old-keyed textarea from the
  DOM fires a native `blur`, which would otherwise re-trigger `commitFocusedDraft` and
  re-commit a draft that's about to be discarded anyway.

**Found and fixed, while testing the above: a stray, inconsistent "collapsed caret"
state.** The design's own rule (interaction-design.md §6) is that a collapsed cursor/
selection is *always* a focused block — `handleMouseUp` already enforces this for every
mouse-driven path, but keyboard-driven collapsing (Left/Right always collapse; Up/Down
collapse without Shift) never went through the same rule, silently leaving a self-drawn
red caret sitting in combined mode instead. **Fixed** by having `moveTo` check whether the
target offset would be a collapse (not an extend) and, if so, resolve which block it
falls in and focus it (reusing `pendingCursorUtf16Ref` so the caret lands at the exact
collapsed position, not the block's end) instead of just setting `cursorOffset`/
`anchorOffset` directly.

**Found while verifying that fix: a more fundamental bug it depended on.** Playwright
verification of the arrow-key fix showed `document.activeElement` was `<body>` after a
cross-block selection created via dragging out of a focused block's textarea (the
handoff mechanism from the earlier drag milestone) — the focused textarea had DOM focus
right up until the handoff unmounted it, and nothing ever claimed focus afterward for
combined mode's hidden textarea. This meant **no keyboard interaction worked at all** for
a handoff-created cross-block selection (arrow keys, typing/Backspace to replace or
delete it) — not just the arrow-key collapse case, since `handleKeyDown` is wired
specifically to that hidden textarea. **Fixed** by having `resolveHandoffDrop` call
`hiddenInputRef.current?.focus()` once it successfully resolves the drop position.
Confirmed both fixes are load-bearing the usual way: disabled `moveTo`'s own check (with
the focus fix left in place) and reproduced the original lingering-caret symptom exactly;
restored it and confirmed a clean collapse into focus with no lingering caret/selection
artifacts.

**Not verified via Playwright, needs real-machine testing**: the toolbar integration
itself — `runStructuralCommand` calls the real `parse_typst_ast` backend command, whose
AST response shape isn't practical to fake convincingly in a mock harness the way
`compile_typst`/`jump_from_click`/`block_geometry` already are elsewhere in this doc: a
wrong mock would give false confidence rather than real coverage. tsc and the full
`vitest run` suite (277 tests) pass; the arrow-key/focus fixes above were verified via
Playwright since they don't depend on real AST parsing.

**Found via real-machine testing of the above: mark-toggle commands (B/I/Code/Link)
applied to the wrong range within a focused block's selection (2026-09-11).** Reported
live: selecting text (e.g. "view", "through ") in a focused textarea and clicking a mark
button wrapped a shifted range of the same length instead — "through " (8 chars) became
"ugh ever", offset by exactly 4 bytes. This session's own frontend selection-capture code
(the `selectionStart`/`selectionEnd` → byte-offset conversion added for the toolbar
integration above) was verified correct first, by temporarily logging the exact substring
it computed — it matched the real selection both times, ruling out that code as the cause
and pointing instead at the deeper PM-position ↔ Typst-byte-offset mapping
(`spokes/typstAst.ts`, built earlier for M5's WYSIWYG cursor sync, unused outside it until
this pass). Manually reconstructing the position-map entries nearest the target byte range
from debug output showed a real, consistent 4-byte-too-far offset — matching exactly 2 em
dashes ("Typst Editor — M5", "...above — they all...") appearing earlier in the demo
document.

**Root cause**: `leaf()`/`join()`, the two helpers `pmDocToTypstWithPositions` uses to
build its `PositionMapEntry[]` map, computed `typstFrom`/`typstTo` via JavaScript string
`.length` — UTF-16 code units — even though every consumer of these values (this map's own
reverse lookups, `TypstLiveView.tsx`'s `cursorOffset`/`anchorOffset`, `jump_from_click`,
`block_geometry`) treats them as UTF-8 **byte** offsets, matching what the Rust backend
uses throughout. An em dash is 1 UTF-16 code unit but 3 UTF-8 bytes, so every position-map
entry after one was silently undercounted by 2 bytes per such character — a genuinely
separate, previously-uncaught defect in a module this pass never otherwise touched, not
something the toolbar-integration work introduced; it surfaced now only because this is
the first feature to interpolate a *selection range* (not just a single click point)
through that map against a document containing multi-byte characters.

One red herring along the way, worth recording so it isn't mistaken for a real finding on
a future re-read of old debug output: an early debug log's `debugSource.slice(anchorOffset,
cursorOffset)` mixed a UTF-16-indexed `.slice()` with byte-offset arguments, producing a
misleading `intendedSubstring` independent of the actual bug — not evidence that the
source used to build the map differed from the source the command ran against.

**Fixed** in `spokes/typstAst.ts`: `leaf()` now derives `typstTo` via
`utf16ToByteOffset(text, text.length)`; `join()` tracks its running `base` offset as byte
length (accumulated incrementally per part, not by re-encoding the whole accumulated
string on every iteration — would have been O(n²) on a large document). Regression test
added (`typstAst.test.ts`): a two-paragraph document with an em dash in the first paragraph
asserts the second paragraph's mapped byte offset accounts for the dash's full 3-byte
encoding, not its 1-code-unit JS length. `tsc --noEmit` clean; full suite now 278 tests,
all passing (277 pre-existing + the 1 new regression test; no existing fixture happened to
place a multi-byte character before a mapped target, which is why nothing caught this
until real-machine use surfaced it).

**Known, separate, still-remaining limitation, not addressed by this fix**: interpolating
a target position that lands *inside* a marked-up run (bold/italic/code) remains only
approximate, because the Typst-serialized wrapper characters (`*`/`_`/`` ` ``) make that
entry's byte span (`typstTo - typstFrom`, wrappers included) differ from its PM position
span (`pmTo - pmFrom`, wrappers excluded). Distinct from the byte-counting bug just fixed;
same acceptable-approximation status this doc's earlier M5 interpolation note already
established for single-point clicks, just not yet re-examined for range selections
specifically.

**Backend algorithmic fix for `geometry_for_range` (2026-09-14)**, promoted from "someday"
in the "Next steps" list above once real-machine testing on the multi-page fixture showed
the cost scaling badly with document size (see the lazy-fetch milestone above for the full
tradeoff analysis against the frontend-only mitigation shipped at the time). `geometry.rs`'s
`geometry_for_range` used to walk `document`'s entire frame tree once *per requested range*
— `block_geometry`'s real caller (`compile.rs`) requests one range per on-screen block, so
an N-block document cost N full tree walks per call, each re-resolving every glyph's source
span from scratch via `glyph_source_offset`'s `world.range(span)` lookup. **Fixed** by adding
`geometry_for_ranges`, which walks the tree exactly once for however many ranges are
requested together, bucketing each hit into whichever range it falls in: a glyph's source
byte offset is resolved once (not once per range), then matched against the target ranges by
binary-searching them sorted by `start` (`find_containing_range`) rather than checking every
range in turn. This assumes the ranges don't overlap — true for `blockByteRanges`-derived
block boundaries (the only real caller) but not enforced by the function itself, documented
plainly in its doc comment rather than asserted at runtime. Image hits (far rarer than
glyphs, matched by span-overlap rather than a single point) are still checked against every
range directly — not worth the same bucketing complexity for something this infrequent. The
old single-range `geometry_for_range` stays, but only as a private test helper now (moved
into `geometry.rs`'s own `mod tests`) — `block_geometry_with_world` (`compile.rs`) calls
`geometry_for_ranges` directly, and no other production caller ever wanted the single-range
form.

Verified with a regression test (`geometry_for_ranges_matches_calling_geometry_for_range_once_per_range`)
asserting the batched call produces byte-for-byte identical output to calling the old
per-range function in a loop — the rewrite changes how many times the tree gets walked, not
any actual result. Two more tests cover what the rewrite could plausibly have gotten wrong:
results come back indexed by the caller's *input* order even when ranges are passed out of
document order (the internal sort-by-`start` used for the binary search must never leak into
the output), and an empty `ranges` list returns an empty `Vec` rather than panicking on the
now-inverted loop structure. Full Rust suite (90 tests) and `cargo clippy --all-targets`
clean; frontend `tsc`/`vitest` (278 tests) unaffected, since this is a backend-only change
with the same `block_geometry` IPC shape as before.

**Real-machine follow-up (2026-09-14): reported live as "focus-entry is still slow, neighbors
still stuck on Compiling…" after the fix above landed.** Investigated directly against the
Rust backend (temporary timing instrumentation, removed once the cause was found — this
doc's own established pattern) rather than guessing from the frontend symptom alone, since
the fix under test is backend-only. Two things confirmed, both good news, neither a
correctness bug:
- **The fix itself measurably works.** On a document close to the real
  `m21-multipage-test.typ` fixture's size (7 pages, 81 blocks), 3 calls to the old
  per-range function took 631ms total; one call to the new batched function took 195ms —
  a real ~3.2x reduction, not just a theoretical one. Box counts matched exactly between
  the two (`[3, 5, 4]` both ways) — no correctness regression, geometry keeps resolving
  to real, non-empty content.
- **The remaining ~195ms is a debug-build artifact, not a production-representative
  number.** The identical comparison under `cargo test --release` came back at 16.7ms for
  the batched call (49.5ms → 16.7ms, same ~3x ratio) — an 11.7x gap between debug and
  release for the exact same code and document, matching this doc's own earlier M14
  finding ("Typst's layout pass is 10x+ slower under `cargo test`'s default debug
  profile"). `pnpm tauri dev` (what real-machine testing in this doc always runs under)
  builds in that same unoptimized debug profile — confirmed from its own startup log,
  `Finished `dev` profile [unoptimized + debuginfo]` — so this ~200ms-class latency during
  development is expected, was already present (worse, at ~600ms-class) before today's
  fix, and is not representative of what a release build would feel like.

Net: today's fix is confirmed correct and effective (~3x faster by construction, verified
by direct measurement, not just by algorithmic reasoning); the "still feels slow" report
reflects a pre-existing, debug-build-only cost this particular fix was never going to
eliminate (it targets the *walk-count* multiplier, not the underlying per-glyph
`world.range(span)` cost, which is what actually dominates in an unoptimized build). Not
promoted to a further task on that basis — revisit only if the same slowness is confirmed
to persist in a release build, which this measurement suggests it won't.

**Found via the same real-machine follow-up: a genuine, pre-existing correctness bug —
"the first two blocks stay stuck on Compiling… forever."** Not the timing question above;
a real bug in the *frontend's* lazy-ink-tracking logic (`fairShareBoundsFromInk`,
`splitLayout.ts`), unrelated to today's backend change — it already existed under the old
per-range-call code too, just never surfaced before because nothing had previously tested a
document whose first block renders *nothing at all*. `test-fixtures/m21-multipage-test.typ`
opens with `#set text(size: 11pt)` — a real block boundary (`blockByteRanges` splits on the
blank line after it) but zero glyphs, so `unionYRange` of its (empty) box list returns
`null`. `blockInkRangesRef` only ever recorded an index when `ink` was truthy
(`if (ink) blockInkRangesRef.current.set(i, ink)`), so this block's entry was never written —
indistinguishable from "not fetched yet." Two consequences, confirmed by reading the code
rather than guessed: (1) this block itself would be re-fetched on every single focus/switch/
scroll near it, forever, since `toFetch`'s filter only excluded indices already *in* the ink
map; (2) `fairShareBoundsFromInk`'s own null-if-neighbor-unknown rule then permanently
blocked the *next* block too (`= Section 0`, which renders completely normally on its own) —
its fair-share midpoint needs to know where block 0 sits, and block 0 was never going to
report back. Exactly matches the live symptom: the first two blocks, specifically.

**Fixed**: `blockEmptyIndicesRef` (`TypstLiveView.tsx`) now records "fetched, confirmed zero
glyphs" separately from "has real ink," checked by both the `toFetch` filter and the
`IntersectionObserver` callback's skip check, so an empty block stops being endlessly
re-fetched. `fairShareBoundsFromInk` (`splitLayout.ts`) takes this set as a new parameter and
walks *past* confirmed-empty neighbors (`nearestRealInk`) when looking for the nearest real
ink to share a midpoint boundary with, instead of returning `null` forever the moment it
meets one — an invisible block occupies no vertical space, so it's transparent for this
purpose. A block that is itself confirmed-empty gets a genuine zero-height share, anchored at
the midpoint between its own nearest real neighbors (there's nothing of its own to crop, so
any positive height would just show blank page under its name for no reason). Handles
multiple consecutive empty blocks (e.g. several `#set`/`#let` lines in a row) by continuing
the walk past all of them, not just one.

Four new unit tests (`splitLayout.test.ts`): an empty block gets a correct zero-height
midpoint share; a real block whose only-known neighbor is empty resolves via the page edge
instead of waiting on it forever; the walk correctly skips *multiple* consecutive empty
blocks to find real ink on either side; and — the key non-regression check — a genuinely
not-yet-fetched neighbor (neither ink nor confirmed-empty) still correctly returns `null`
("not ready"), so the fix doesn't accidentally treat "unknown" and "empty" as the same
thing. `tsc --noEmit` clean; full suite now 282 tests, all passing. Confirmed live: block 0
resolves out of "Compiling…" into a real (zero-height) crop instead of staying stuck forever.

**Found via that same real-machine confirmation: focusing a block far into a large,
mostly-unfetched document visually "jumped back to page 1."** Not a navigation bug — a
"Compiling…" placeholder (`.typst-live-block-placeholder`) reserved no height of its own
(one line of italic text), and entering split mode only prefetches `[idx-1, idx, idx+1]`
(the lazy-fetch milestone above), so every other block — including dozens of pages' worth of
real content above the clicked one — collapsed to a sliver of placeholder text the instant
focus entered. The newly-focused block's *actual* DOM position, in that artificially
compressed layout, really was near the top — the browser's native focus-triggered
auto-scroll then (correctly, given the layout it saw) scrolled there. As each placeholder
above the focused block later resolved to its real (usually much taller) height and pushed
things down in normal document flow, the fixed scroll position was never re-corrected,
compounding the same problem on every resolution.

**Fixed, two complementary pieces** (deliberately both — one alone narrows the problem, the
other alone leaves it to correct itself late):
- `estimatePlaceholderHeightPt` (`splitLayout.ts`, new, unit-tested): estimates an unfetched
  block's height from its own byte length, calibrated against whatever real ink-to-byte
  ratio is already known from other resolved blocks in the same document — self-calibrating
  rather than a hardcoded guess, falling back to a rough constant (~14pt/80 bytes, ~11pt body
  text) only for the very first paint before anything has resolved to calibrate against.
  Applied as each placeholder's `min-height` (`TypstLiveView.tsx`'s `renderOtherBlock`, scaled
  pt→px the same way focused-block margins already are). Narrows the compression — an
  imperfect estimate is still far closer to reality than zero.
- An explicit scroll correction (`TypstLiveView.tsx`): `el.focus()` on the newly-focused
  textarea now passes `preventScroll: true` (suppressing the browser's own auto-scroll, which
  fires against whatever the still-mostly-unresolved layout looks like at that exact instant)
  and a separate `useLayoutEffect`, keyed on `[focusedBlock, otherBlocksYRanges]` (not just the
  initial focus), calls `el.scrollIntoView({ block: "nearest" })` instead — re-running, and
  re-correcting, every time a sibling's placeholder resolves and shifts the focused block's
  position, not just once.

Four new unit tests for `estimatePlaceholderHeightPt` (`splitLayout.test.ts`): scales linearly
with byte length once a ratio is known; averages across every known block, not just the
first; falls back to the documented constant (not zero, not `NaN`) when nothing is known yet;
handles a zero-byte-length known block without producing `NaN`. `tsc --noEmit` clean; full
suite now 286 tests, all passing.

**The fix above did not actually fix it — real-machine re-testing (2026-09-14) still showed
the jump.** Both the placeholder-height estimate and the `scrollIntoView` correction address
a real effect (split mode's initial layout is shorter than the real document until more of it
resolves), but neither was the reported bug's actual cause, and re-testing confirmed the jump
was completely unchanged. Investigated further with direct instrumentation rather than
another guess: a temporary capture-phase `scroll` listener on `document` showed the user
genuinely scrolling `.typst-live-view` deep into the document (`scrollTop` climbing past
7000), then — right as a click registered — several consecutive `scroll` events fired with
no valid `event.target` at all, immediately followed by `.typst-live-view` reporting
`scrollTop: 0`. Two follow-up hypotheses built on this evidence (restoring from
`lastScrollRef` on the `focusedBlock` transition, then a dedicated pre-transition snapshot
ref to sidestep a suspected race where the reset's own `scroll` event corrupted
`lastScrollRef` before the restore could read it) were each implemented, tested live, and
each still failed to fix it — real, incremental root-causing, not a single lucky guess.

**Actual root cause**: `.typst-live-hidden-input` (the always-mounted textarea that captures
keystrokes/IME in combined mode) is styled `position: absolute; top: 0; left: 0` — relative
to `.typst-live-stage`, which *is* the full-height combined-mode content, not the viewport.
It has always sat at the very top of the whole document, at every scroll position, since M20.
`handleMouseDown` calls `hiddenInputRef.current?.focus()` on *every* mousedown (needed so the
hidden input keeps keyboard focus for the click that follows) without `preventScroll` — the
browser's default "scroll the newly-focused element into view" then fires immediately,
snapping `.typst-live-view` back to `scrollTop: 0` on every single click, before
`offsetAtClient` even reads the click's coordinates. This is why a click made while scrolled
deep into the document could *also* resolve to the wrong (much earlier) offset entirely,
reported separately earlier the same day: `svgPointFromClient`'s `getBoundingClientRect()`
read happens synchronously, by which point the container had already jumped back to the top
underneath it — one root cause explaining two reported symptoms.

**Fixed**: both of `hiddenInputRef`'s `.focus()` call sites (`handleMouseDown`, and the
handoff-focus-restore call documented earlier this doc) now pass `{ preventScroll: true }`.
The earlier placeholder-height-estimate and `scrollIntoView`/scroll-restore mechanisms are
kept, not reverted — they address a real, separate effect (split mode's layout being
genuinely shorter than the real document until unresolved siblings' geometry arrives) that
remains worth having even with the actual bug fixed. Confirmed live: focusing a block deep in
the multi-page fixture after scrolling down now correctly expands that block in place,
without the view jumping back to the top.

**Found and fixed the same day: unresolved "Compiling…" placeholders didn't settle starting
from near the newly-focused block outward.** Entering split mode registers every non-focused
block with the same `IntersectionObserver` at once; the browser's first callback for a
freshly-observed target reports every *currently* intersecting block together, in one batch —
several can be newly-visible simultaneously, not just one. That batch's own `entries` order is
observation order (ascending block index, since that's the order `.map()` mounts them in
React), unrelated to how visually close each one is to the block the user just focused.
**Fixed** by sorting each callback's qualifying entries by `|idx - focusedBlock|` before
issuing their `ensureBlockGeometry` calls — each call is independently async and not awaited,
but issuing the nearest one first still gets it processed (and painted) first in practice,
since the backend handles one IPC call at a time. Confirmed live: placeholders now visibly
settle outward from the focused block instead of in arbitrary index order.

**Up/Down cross-block navigation (2026-09-15)** — the last of M23's deliberately-deferred
items, alongside reference-chain navigation UI (still not started). A native `<textarea>` has
no public API for "which visual (post-wrap) line is the caret on," so reimplementing line-wrap
measurement was avoided in favor of the standard technique for this exact limitation: let the
browser's own Up/Down handling run first, then check on the next animation frame whether it
actually moved the caret. No movement means there was nowhere further to go *within this
block* — only then does `crossBlockBoundary` fire, focusing the adjacent block and landing the
caret at the far end from the direction of approach (its end for Up, its start for Down).
Deliberately mirrors `switchFocusTo`'s own commit-then-relocate-by-byte-position logic exactly,
not a fresh reimplementation: committing the currently-focused block's draft as part of
crossing can change how many blocks exist before/after it (typing a blank line splits one in
two), so the target is resolved by where its byte position now lands, not by trusting
`focusedBlock ± 1` as a still-valid array index — the same class of bug `switchFocusTo` itself
was fixed for earlier in this doc. Only fires for a collapsed caret; Shift+Up/Down (extending a
selection across the block boundary) is out of scope for this pass, same as it was for M23's
mark-toggle work. Verified live: pressing Up on a focused block's first line lands in the
previous block; Down on the last line lands in the next block; both feel immediate, no visible
lag or wrong-block flicker.

**Reference-chain navigation implemented (2026-09-15)** — the last item on M23's own deferred
list (§10 结论 14: a list above the focused textarea of "which variables/labels this block
references," click an item to jump to its declaration; only the usage→definition direction,
the reverse — definition→all usages — stays deferred to §5A/§5C's future citation picker).

Before implementing, went back and re-checked the requirement and existing design for gaps,
and thought through performance for both small and large documents specifically — the
starting assumption (hand-roll a Typst syntax-tree walker for `#let`/`<label>`/`@ref`) would
have needed real scope resolution to get `#let` right (the same name can be bound differently
in different scopes; getting this wrong silently sends the user to the wrong declaration), which
was going to push `#let` support to a later pass and ship only labels/refs first. Checking
`typst-ide` (already a dependency — `jump.rs` already uses it for click/cursor sync) before
building any of that changed the plan: it already exports exactly this "go to definition"
capability, built for the same reason real language servers need it —
`typst_ide::deref_target(leaf) -> Option<DerefTarget>` classifies a syntax node as a reference
site (variable access, callee, label, ref, import/include path); `typst_ide::definition(world,
output, source, cursor, side) -> Option<Definition>` resolves a cursor position to where it's
declared — for `#let`/`#import` via `named_items` (a real ancestor/preceding-sibling scope
walk, not a name-text match), for `@ref`/`<label>` via the compiled document's `Introspector`.
Both are already covered by `typst-ide`'s own test suite. This meant v1 could cover `#let`/
`#import` bindings *and* `<label>`/`@ref` cross-references together, without the scope-
resolution risk that would have justified cutting `#let` for a later pass.

**`#set` rule influence tracking is explicitly not covered, and this is a real scope boundary,
not an oversight**: `#set text(size: 11pt)` doesn't bind a name later content can reference by
identity — its effect is implicit and positional (applies to everything after it in scope).
`deref_target`/`definition` have no query for "which `#set` affects this cursor" at all;
supporting it needs a different analysis (walk backward from the block for the nearest
preceding `#set` of each relevant target) and stays a distinct, deferred item.

**Performance, worked through explicitly for both a short document and a long one**: parsing
(`typst_syntax::parse`) is O(document length) but is lexing/parsing only, already paid
elsewhere (`parse_typst_ast`) and cheap regardless. Finding the block's own syntax subtree
descends from the root only into children whose span covers the block's byte range —
O(tree depth), not O(document length). Enumerating candidate reference sites and resolving
each one is bounded by that one block's own size, not the document's: `#let`/`#import`
resolution via `named_items` costs however deep the local scope chain is at that specific
reference site, unrelated to how many other `#let`s exist elsewhere in the document; label/ref
resolution goes through the compiled document's `Introspector`, which indexes labels in a real
hash map (`labels: MultiMap<Label, usize>`) built once as part of normal compilation — an
amortized O(1) lookup, not a scan. The one genuinely required cost — a compiled `PagedDocument`
(label resolution needs it; `#let` resolution doesn't) — reuses the session's persistent
`TauriWorld` + comemo caching `block_geometry` already established (M14): a cache hit, not a
second real compile, when `source` is unchanged. Net: cost tracks the focused block's own size
and how many references it makes, not total document size — a long document costs the same as
a short one for this specific operation. (Found along the way, unrelated to this task: `jump.rs`'s
`jump_from_click`/`jump_from_cursor` still build a fresh `TauriWorld` per call rather than
reusing the session one — a pre-existing gap from before M14's optimization landed, left as-is.)

**Implementation**: `src-tauri/src/references.rs` (new), `find_block_references(source,
base_dir, block_start, block_end)` — descends to the smallest syntax subtree covering
`[block_start, block_end)`, collects its leaf nodes, calls `deref_target` on each, and for every
`VarAccess`/`Callee`/`Ref` hit calls `definition` once. Keeps only `Definition::Span` results
that resolve inside the same file (`Definition::Std` — standard-library symbols — and
`Definition::File` — cross-file, not applicable to this single-document editor — are filtered
out, since neither has anywhere real to jump to); filters out a `#let`'s own declared name
resolving to itself (`deref_target` classifies a binding's own `Ident` as `VarAccess` too, same
as any other identifier); deduplicates by definition position, so the same binding referenced
twice in one block shows once. `sync_session` (compile.rs) made `pub(crate)` so this module
reuses the exact same session-World pattern `block_geometry` already uses, instead of
introducing a second one. `TypstLiveView.tsx`: fetches on focus change/source change (not
per-keystroke, matching the performance analysis above), renders a pill-button list
(`.typst-live-reference-list`) directly above the focused textarea, hidden entirely when a
block has no references. Clicking an item calls `jumpToReference`, modeled directly on
`crossBlockBoundary`'s own commit-then-relocate-by-byte-position logic (committing the
currently-focused block's draft can shift where the target definition now sits, the same way
it can shift an adjacent block's start byte).

Eight new Rust unit tests (`references.rs`): a `#let` binding resolves correctly; the same name
bound in two different scopes resolves to whichever is locally visible (proves this goes
through real scope resolution, not a first-match name search); a label reference resolves to
its labelled element (matches `typst-ide`'s own convention of pointing at the element, not the
bare `<label>` token — acceptable at this project's block-level jump granularity, since the
label sits in the same block as what it names); a reference to a nonexistent label is silently
omitted, not an error; a standard-library function reference is filtered out; a `#let`'s own
name doesn't reference itself; the same binding referenced twice in one block dedupes to one
entry; and — the direct check on the performance claim above — a synthetic ~50-section
document confirms only the queried block's own subtree gets processed, not the whole document.
`cargo test` (98 total) and `cargo clippy --all-targets` clean; frontend `tsc`/`vitest`
(286 tests) unaffected. Not yet confirmed on real hardware — next step.

**Real-machine testing (2026-09-15) found three real bugs, all fixed the same day.**

**Misaligned with the textarea below it**: the reference list had no margin of its own, while
the textarea gets `marginLeft`/`width` from `focusedBlockLayoutPx` to line up with the page's
real content edge (the "sixth pass" fix earlier in this doc). Fixed by giving
`.typst-live-reference-list` the same `marginLeft`/`width` the textarea already computes.

**Clicking a reference item didn't jump — it just exited the textarea.** Same root cause as an
M23 toolbar bug fixed earlier in this doc: the reference-list `<button>`s live inside the same
conditionally-rendered fragment as the focused textarea. Clicking one first fires a native blur
(the button is stealing DOM focus), which commits the draft and — since that sets
`focusedBlock` to `null` — unmounts the whole fragment, button included, before the click event
it's still in the middle of dispatching ever reaches `onClick`. The click silently never fires;
it just reads as "clicking exits the textarea." **Fixed** with the same
`onMouseDown={(event) => event.preventDefault()}` the toolbar buttons already use, which keeps
the textarea focused through mousedown so the blur/unmount never happens in the first place —
`jumpToReference`'s own explicit commit-and-relocate logic handles the transition instead.

**Found via the same testing pass, unrelated to reference navigation itself: exiting focus and
quickly clicking other blocks could reopen an earlier-clicked block instead of the last one
actually clicked.** Two distinct async races, found and fixed in sequence as the first fix only
reduced (didn't eliminate) the reported frequency:
1. `enterFocus`/`switchFocusTo`/`crossBlockBoundary`/`jumpToReference` are all async (each
   awaits an `ensureBlockGeometry` round trip) and none of them guarded against a *newer* one
   finishing first — rapid clicks across several blocks could resolve out of order, since
   whichever call's `await` happened to settle last always won, regardless of click order.
   **Fixed** with a shared `focusRequestIdRef` counter, bumped at the start of each of the four
   functions; each captures its own value and checks it's still current right after its
   `await`, before touching any state — the same "is this result still for the request that's
   still relevant" discipline `blockInkSourceRef`/`isPending` already use elsewhere in this
   file, applied to focus changes specifically.
2. One layer further upstream, in the plain-click path itself: `handleMouseUp` read
   `anchorOffsetRef`/`cursorOffsetRef` *synchronously*, but those refs are only written inside
   `handleMouseDown`'s own async `offsetAtClient(...).then(...)` (an `invoke` round trip) — a
   mouseup firing before that resolved would read stale values left over from an earlier click,
   or from init. A real click's mousedown→mouseup gap is normally just wide enough for the
   round trip to finish first, which is why this only showed up "occasionally" rather than
   every time, and why fix 1 alone visibly reduced (without eliminating) the frequency — it's a
   genuinely separate race, one step earlier than anything fix 1 guards. **Fixed** by awaiting
   `mouseDownResolvedRef.current` — the exact promise *this* click's own mousedown produced,
   captured before any newer mousedown can reassign the ref — before reading the offsets;
   mirrors `resolveNextDragPoint`'s own existing use of the same ref, just applied to the
   plain-click path too, which had been missing it.

All three confirmed live. `tsc --noEmit` clean; full suite still 286 tests, all passing.

### Cross-block undo/redo (interaction-design.md §8, P0)

The one remaining P0 gap from that document: no app-level undo/redo history anywhere.
Ctrl+Z worked only by accident, via the browser's own per-`<textarea>` history for a
focused block, scoped to that one visit — exiting focus, switching blocks, or running a
toolbar command threw it away with no way back.

**Design** (worked out over several rounds of pushback — a first pass asserted an
unjustified `MAX_HISTORY = 200` full-snapshot cap; landed instead on a delta-based
design with real prior art behind it, read directly out of
`node_modules/@codemirror/commands/dist/index.js` — the `history()` extension this repo
already vendors and `SourceEditor.tsx` already uses for the Typst-source/Markdown tabs,
not recalled from memory):

- History lives entirely inside `TypstLiveView.tsx` (a ref, `historyRef`) — `App.tsx`'s
  `source`/`onChange` interface doesn't need to know undo exists.
- Two commit wrappers replace all 8 of this file's `onChange(...)` call sites
  (`commitFocusedDraft`, `switchFocusTo`×2, `crossBlockBoundary`, `jumpToReference`,
  `resolveHandoffDrop`, `commitEdit`, `runToolbarCommand`×2): `commitChange` for the 7
  splice-based sites, `commitSnapshot` for `runToolbarCommand`'s 2 (a structural
  transform's old/new source aren't one contiguous byte-range replacement). Each call
  site constructs its own `beforeFocus` from already-correct local/closure state — a
  generic "read current React state" helper would be wrong, since whether
  `focusedBlock`/etc. reflect "before" or "after" this commit at the moment `onChange`
  fires differs per call site (e.g. `resolveHandoffDrop` calls `setFocusedBlock(null)`
  *before* `onChange`; most others call their state setters *after*).
- **Entries store a delta (`{ start, removed, inserted }`), not a full document
  snapshot**, for the 7 splice-based sites — `spliceSource` already knows exactly what
  changed at commit time, so this costs nothing extra and scales with edit size, not
  document size. Only `runToolbarCommand`'s 2 sites (whole-document
  parse→PM-transform→serialize round trips) keep full-snapshot entries.
- Combined-mode per-keystroke coalescing (`commitEdit`, the one call site that fires on
  every keystroke) needs two conditions to merge into one undo entry, not just a time
  window: within `COALESCE_MS` (500ms, CodeMirror's own default) **and** the new edit's
  range is adjacent to where the previous one left off (`deltasAdjacent`,
  `editHistory.ts`) — mirrors CodeMirror's own `isAdjacent` check; a time window alone
  would wrongly merge two edits in unrelated parts of the document if they happened to
  land within 500ms of each other. A coalesced run stores a `Delta[]` array (each
  keystroke's own delta), not one merged delta — undo/redo applies each individually in
  sequence, sidestepping the real correctness problems a general insert/delete-mixing
  merge algorithm would have.
- Seamless native→app handoff: Ctrl+Z while a block is focused doesn't `preventDefault`
  — native undo runs first, checked on the next animation frame (the same "let native
  run, check if it moved" technique already used for Up/Down cross-block navigation);
  no change means native history for this visit is exhausted, and control hands off to
  the app-level `undo()`.
- Focus restoration lands at the target block's content end, not a precisely-tracked
  prior cursor position — a deliberate v1 simplification (CodeMirror itself restores
  exact selection via `ChangeSet`-mapped positions, which this project's split
  block/combined coordinate systems don't support without solving a bigger "map a
  position across coordinate systems" problem first). Block-count changes (a commit
  that splits/merges blocks) don't break restoration, since each entry's `focus.blockIdx`
  and its associated source are captured as a matched pair — restoration recomputes
  `blockByteRanges` on the entry's *own* reconstructed source, never the live/current one.
- No stack-depth cap for v1 — checked that CodeMirror's own `minDepth` (default 100)
  exists mainly to bound the cost of remapping *every* stored entry's positions on
  *every* subsequent edit (`addMappingToBranch`), a cost this design doesn't have since
  entries are inert until actually popped; only raw memory remains as a concern, and
  delta storage already keeps that small. Left as a known, disclosed, deliberately
  deferred follow-up (a byte-budget eviction, if ever needed).

**Implementation**: `src/editor/editHistory.ts` (new) — pure logic (`Delta`,
`HistoryEntry`, `recordChange`, `popUndo`/`popRedo`, `deltasAdjacent`,
`applyDeltaForward`/`applyDeltaInverse`, `undoDeltas`/`redoDeltas`), 17 unit tests
covering coalescing (including the adjacency-vs-time-window distinction, and a
regression case for chained backspaces — a naive "new delta's start must be ≥ the
previous one's" adjacency check breaks for the *second* backspace in a chain, since each
subsequent one's start is strictly *before* the last; fixed with a symmetric check
against where the previous delta's own edit left off). `TypstLiveView.tsx`: `historyRef`,
`commitChange`/`commitSnapshot`/`applyFocus`/`currentFocusSnapshot`/`undo`/`redo`, a
`handleGlobalKeyDown` bound once on the outer `.typst-live-view` container (catches
Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y bubbling up from either the hidden input or
a focused block's own textarea), and all 8 call sites updated. `undo()`/`redo()`
deliberately do the stack pop and `onChange` *synchronously*, before any `await` —
unlike `switchFocusTo`/`crossBlockBoundary`/`jumpToReference`'s own async-gated
`onChange` (safe there since their `effectiveSource` is cheaply recomputable by a
superseding call), a stack pop is a one-shot, non-idempotent mutation; gating it behind
`applyFocus`'s async geometry fetch would risk `historyRef` and `source` silently
diverging if a second Ctrl+Z fired before the first one's fetch resolved. Only the
focus-layout part is async (mirrors `enterFocus`).

`npx tsc --noEmit`, `npx vitest run` (302 tests, up from 286), `cargo test` (98,
unaffected — no backend changes) and `cargo clippy --all-targets` all clean.

**Real-machine testing (2026-09-15) found two focus-loss bugs, both fixed the same day.**

**Undoing back onto an already-focused block left the new textarea rendered but not
actually focused** (needed a click before typing would go anywhere again). The block-focus
effect (`useLayoutEffect` that calls `.focus()`/positions the caret) was keyed only on
`[focusedBlock]` — landing `undo()` back on the *same* block index is a no-op as far as
that state value is concerned, so the effect never re-ran, even though a genuinely new
`<textarea>` had just been mounted (its `key` folds in `focusGeneration`, which *did*
bump). **Fixed** by adding `focusGeneration` to that effect's dependency array — it's
exactly the signal for "a (re-)focus happened," independent of whether the index changed.

**Ctrl+Z did nothing at all after leaving a focused block (e.g. via Escape) without
clicking anywhere else first.** `commitFocusedDraft`'s blur path set `focusedBlock` to
`null` but never gave DOM focus to anything else, so combined mode had *nothing* focused
— no element for the keydown to bubble through. `resolveHandoffDrop` had already hit and
fixed this exact problem for one specific transition into combined mode; **fixed**
generally with a `useLayoutEffect` that focuses the hidden input whenever
`focusedBlock` becomes `null`, covering every path that can land there, not just that one.

**Follow-up testing (2026-09-16) found two more real gaps, both fixed the same day.**

**Focusing a block, typing nothing, and blurring (or dragging out of one without typing,
or Backspace/Delete at a document boundary) still recorded a history entry.** Four commit
sites (`commitFocusedDraft`, `switchFocusTo`, `jumpToReference`, the native-drag handoff,
plus `commitEdit`) called `commitChange`/`commitSnapshot` unconditionally instead of only
when the content actually changed, unlike `crossBlockBoundary`, which already guarded on
it correctly. **Fixed** by adding the same `newSource !== source` guard to all of them —
a no-op interaction no longer costs an undo step or risks landing a later Ctrl+Z back on
a block for no visible effect.

**Opening a different document (File → Open / a recent file) left the previous
document's entire undo/redo history intact**, since `App.tsx` never remounted
`TypstLiveView` — it only fed the same component instance new `source`/`onChange` props.
The old document's delta entries (byte offsets and literal text captured against *its*
content) would stay on the stack; the next Ctrl+Z would apply them against the
newly-loaded, unrelated document instead — for a `runToolbarCommand`-style snapshot entry,
that means silently replacing the new document's entire content with a stale snapshot of
the previous one. **Fixed** with a `docGeneration` counter in `App.tsx`, bumped inside
`loadFile` and passed as `<TypstLiveView key={docGeneration}>` — forces a full remount on
every document load, discarding not just undo history but every other piece of
`TypstLiveView`-local state that has no business surviving a document switch either
(which block was focused, in-progress draft text, cursor position).
