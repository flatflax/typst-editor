# Phase 3: single-view engineering validation (M13–M23)

The phase ended on 2026-09-09: core technical feasibility was validated, not product interaction or user value. M23 was incomplete at the time and subsequently moved into [Phase 4](phase4-product-validation.md). This document preserves the experimental basis; [plan.md](../plan.md) defines the current plan.

Document review: 2026-10-23. The plan/result comparison below restores the phase's evolution. Commands are current review entry points; historical measurements were not rerun for this documentation revision.

## Original questions, dependencies, and acceptance principles

The original plan alternated Typst-rendered fragments and editable PM blocks on one document surface. M14 validated compilation cost and M14A validated range geometry, both before M15. M13 was an independent refactoring to reduce conversion-dispatch duplication, not a necessary prerequisite for the single-view mechanism.

After M15 failed, completion no longer meant “PM takes over the cursor in the real layout.” Instead, the question became whether input and cursor/selection state could work from the same Typst geometry. M18's IME experiment and M20's static interaction could be validated independently, then connected into an editing loop by M21. This changed the acceptance goal; simply marking all milestone numbers complete would conceal that change.

## Original goals compared with results

| ID and original goal | Actual result | Evidence / unmet conditions | Deviation and handoff |
|---|---|---|---|
| M13 Reduce duplicate dispatch for new nodes | Centralized inline atoms and schema constraints; block conversions remain directional | Conversion/schema tests; not a new semantic engine | Retained as shared infrastructure without forcing sibling-dependent block logic into one implementation |
| M14 Fast recompilation after edits to support focus swapping | Persistent World benefits unchanged input; real edits still incur scale-dependent cost | Release benchmarks; initial expectations of document-size independence or 16–50ms per keystroke were not met | Retained persistent World; end-to-end performance deferred to later measurement |
| M14A Obtain pages, rectangles, and baselines from byte ranges | Single/wrapped lines, headings, images, footnotes, and cross-page ranges can be located | Six real-engine geometry test categories; multi-column/group-transform boundaries uncovered | Used for cross-block interaction and Phase 4 clipping |
| M15 Seamlessly swap PM editing blocks and Typst fragments | All three attempts had layout/DOM problems; no adoptable mechanism emerged | Prototypes and manual failure records; not implementation completion | Abandoned the mechanism in favor of interaction on shared Typst geometry |
| M15b Extend swapping to tables/images/lists; M17 Cursor continuity between swaps | Cancelled | The underlying swap mechanism was withdrawn | No longer pending features; reaccept related capabilities through the new interaction approach |
| M16 Visual continuity of reflow/pagination | New compilations update the whole document; waiting feedback moved to M22 | No longer needs repairs to stale numbering/footnote fragments left by local swaps | Does not mean all scrolling/clipping issues are solved; Phase 4 continues them |
| M18 Native input bridge for CJK composition | Independent static experiment passed with Chinese Pinyin, Japanese, and Korean | Real IME observations; no full navigation or current cross-block composition display validation | Supports native input; subsequent single-block editing uses textarea |
| M19 Local compilation / second World | Unimplemented | No performance or correctness results for this path | Folded into M21 scope tradeoffs; revisit according to real latency |
| M20 Static cursor/selection on real layout | Clicks, arrow keys, Shift selection, and drag selection work | Geometry unit tests and repeated manual corrections; no text editing yet | Foundation for the composite view; Phase 4 stops querying geometry for every single-block keystroke |
| M21 Input→source→compile→display loop | Insertion/deletion, final composition commitment, and whole-document updates work | Short-fixture and multi-page manual checks; long-document lag and limited live cross-block composition | Ordinary input later moved to local drafts; the hidden input remains for cross-block use |
| M22 Understandable feedback while compilation runs | Temporary source hint disappears when the matching result arrives | Manual checks with short/20-section fixtures; cold-load hint delay unresolved | Hints are not real previews and do not resolve update latency |
| M23 Port Phase 2 toolbar/table/menu capabilities | Block-type switching committed at phase close; marks/tables partly unfinished | Separate phase-close records from later work; no Live slash menu | Marks/tables completed later in Phase 4; slash menu later became undecided |

## M13: reducing duplicate conversion code

Inline-atom dispatch was centralized in `INLINE_ATOM_SPECS_BY_PM_TYPE`; list item nodes, list types, and block types were centralized, with `assertNever` checking branch omissions. Block conversions remain directional because siblings and context differ; they were not forced into one generic converter.

## M14: compilation experiments and measurement boundaries

Historical Release fixtures:

| Condition | Size | Recorded duration |
|---|---|---|
| New World each time, repeated input or single-character edit | 14 pages | 75–110ms |
| New World each time, single-character edit | 27 / 40 pages | Approximately 240 / 390ms |
| Persistent World, unchanged source | 14 pages | Approximately 9µs |
| Persistent World, single-character edit | 14 pages | Approximately 60ms |

Early wrapper calls and persistent-World microbenchmarks used different measurement boundaries. Some records included SVG, while the latter primarily measured compilation. These numbers show caching potential, not a directly comparable end-to-end speedup. Persistent World was retained, with `Source::edit` enabling reuse of unchanged portions.

Another set of “14/40 sections” fixtures recorded beginning/middle/end edits at approximately 21/29/28ms and 69/58/61ms respectively. The limited sample did not show “later edits are faster,” which is insufficient to prioritize fixed-window compilation, but also does not prove that local reuse is impossible in every document.

Compilation debounce was reduced from 250ms to the later 150ms. This phase only established whole-document compilation as usable for short/medium editing loops, not acceptable long-document display latency. The 2026-10-22 Live cursor user report reopened overall performance; see [performance analysis](preview-performance.md).

### M14 experiment reproduction and reporting conventions

Run from the repository root with native Rust/SDK and fonts available:

```sh
cargo test --release --locked --manifest-path src-tauri/Cargo.toml single_character_edit_on_a_multi_page_document_recompile_latency -- --nocapture --test-threads=1
cargo test --release --locked --manifest-path src-tauri/Cargo.toml incremental_edit_on_a_persistent_world_shows_comemos_real_speedup -- --nocapture --test-threads=1
cargo test --release --locked --manifest-path src-tauri/Cargo.toml recompile_latency_after_an_edit_depends_on_position_not_just_document_length -- --nocapture --test-threads=1
```

These tests are in `src-tauri/src/compile.rs`, with fixtures from multi_page_fixture. Section count and actual page count are different variables; fonts, layout, and current code changes may alter page count. Record the actual page count printed by the test rather than reusing historical counts. Loose Debug regression thresholds prevent abnormal regressions; they are not Release performance targets.

Record first compilation, warmed unchanged compilation, and single-character edits separately, stating whether World is persistent and whether SVG is timed. Preserve build revision, Rust version, CPU, fonts, font size, justify, edit position, repetition count, and raw output for each group. The historical table lacks complete machine/distribution records; do not invent p95 values or guarantee the same results.

The early “synchronous 16–50ms per key” expectation conflated input response and compiled display. Later evaluation must separate immediate native input feedback from background completion. This corrects the usability criterion without making waiting disappear. See [preview performance](preview-performance.md) for current full-path measurement requirements.

## M14A: obtaining layout geometry from source

Traverse glyph Spans and character offsets inside Frames to obtain source byte ranges; images return actual rectangles. Text boxes cluster by page and baseline, with heights estimated from font-size metrics. Footnotes and cross-page content may yield multiple boxes, positioned in the merged SVG using page offsets.

Boundaries:

- Same-baseline text in multiple columns may cluster into one box.
- Group translations accumulate, but rotation/scaling remains incomplete.
- Text boxes are approximate geometry usable for editing, not standard line boxes guaranteed by the engine.
- Initial per-range traversal later became batch traversal; see [Architecture](architecture.md) for the current algorithm.

### M14A capabilities and corresponding evidence

All tests below are in `src-tauri/src/geometry.rs`; run `cargo test --locked --manifest-path src-tauri/Cargo.toml geometry::tests` to review them:

| Capability/fixture | Test name | Passing result and boundaries |
|---|---|---|
| Single-line paragraph | a_single_line_paragraph_yields_one_line_box_on_page_one | Page, position, dimensions, and baseline exist; text height approximates font size |
| Wrapped paragraph | a_wrapped_paragraph_yields_one_line_box_per_visual_line | A box per visual line; currently baseline clustering, not formal engine line nodes |
| Heading | a_heading_yields_a_line_box | Heading range maps to actual layout |
| Image | an_image_yields_an_exact_size_box_with_no_baseline | Dimensions come from the image Frame; no fabricated text baseline |
| Footnote body | a_footnote_body_is_locatable_even_though_it_renders_away_from_its_reference | Source locates the actual body area away from its reference |
| Cross-page range | a_range_crossing_a_page_break_yields_boxes_on_both_pages | One range may return multiple boxes on multiple pages; do not collapse them into one page rectangle |

A glyph's source position is the Span's source-range start plus the glyph offset, rather than treating a whole text run as one hit range. Images/shapes use element Spans. Some soft groups are flattened in Frames, leaving no reliable “whole visual line” node; hence baseline clustering. Same-baseline columns need additional horizontal separation to avoid merging. Extending group transforms should compose transformation matrices rather than continue accumulating translation only.

## M15: why block swapping was not adopted

| Attempt | Main problem | Conclusion |
|---|---|---|
| Swap DOM inside PM NodeViews | ProseMirror DOM reconciliation conflicts with external node replacement and can damage the document | Not adopted |
| Fixed overlay above rendering | Two sets of font, dimension, and scrolling calculations cannot align reliably; growth covers later content | Not adopted |
| Place before/after SVG crops and a focused PM block in document flow | Multiple pages cannot be reduced to one rectangle; two layouts still have visible transitions at focus | Not adopted |

The historical snapshot was named `spike/m15a-block-swap`; it is an experimental record, not a promise that the branch exists in the current checkout. Reusable geometry and the session World remained in the main implementation.

The revised rule: Typst supplies layout geometry; the editor owns input, cursor, and selection state and displays interaction against that geometry. Structural operations may temporarily use PM document transformations without permanently mounted PM layout. Phase 4 goes further by assigning single-block input to a native textarea that explicitly displays source, avoiding presentation as final layout.

This experiment rejected the specific approach of “joining two layout outputs without visible differences and using the PM cursor to interpret Typst glyphs.” It did not prove every focus-switching interaction impossible. Later native-source blocks explicitly accept different styling and move neighbors through document flow; this new approach changes the premises and must not be conflated with success of the M15 mechanism.

## M18: native CJK input experiment

The independent page `spike/m18-ime/index.html` historically passed manual checks with Windows Chinese Pinyin, Japanese, and Korean IMEs. Observations included:

- `compositionupdate.data` is the entire current composition string and must replace rather than append; Japanese candidate changes and Korean syllable composition follow their respective event cycles.
- Standard browser composition events do not expose detailed candidate-clause boundaries.
- The input element must be near the cursor to anchor the system candidate window correctly.
- Deletion events before composition ends may report `isComposing=false`, requiring independent composition state.
- Changing composition-text width also requires updating a custom cursor's position.

The experiment did not validate full navigation. It supports choosing native input, but does not establish complete composition preview and candidate positioning in the current cross-block hidden input.

When reviewing, observe active input, candidate changes, confirmation, Backspace clearing, cancellation, and consecutive syllables separately, rather than only final compositionend characters. The historical independent-page path identifies the prototype; the product must be rechecked in its own controls, scrolling, and focus environment. Prototype success cannot substitute for product acceptance.

## M20: composite-view interaction

Implemented clicks, left/right/up/down movement, Shift selection, and drag selection. The cursor prefers the next glyph's leading edge, otherwise the previous glyph's trailing edge; visible height is trimmed relative to the baseline. Vertical movement queries real adjacent lines, retains the original horizontal position, and constrains the landing point within the target line. Dragging processes only the latest position; vertical keypresses execute FIFO without dropping repeats.

Key issues found and corrected manually:

| Symptom | Correction |
|---|---|
| Cursor too tall; vertical movement loses steps | Adjust visible cursor height and query geometry from the current offset each time |
| Horizontal overlay offset in wide windows | Size the stage to actual SVG width rather than parent flex stretching |
| Navigation fails with mixed font sizes, short lines, or space outside lines | Use real line geometry, clamp horizontal landing points, and choose the nearest line |
| Quick mouse release leaves dragging active | Set dragging state synchronously on mousedown so asynchronous queries cannot arrive after mouseup |
| Multi-page positions use only the first page | Use page offsets and inter-page spacing in merged coordinates |

## M21: source-editing loop

A hidden native input receives text; insertion, deletion, and replacement operate on UTF-8 source ranges before whole-document compilation. Final text commits at composition end; live composition overlays did not yet exist.

Historical fixes included preventing mousedown from stealing focus; inserting Typst paragraph separators `\n\n` on Enter; progressively expanding empty-range geometry queries to usable characters (up to 256 bytes); handling Backspace/Delete on keydown for an empty hidden textarea; and restoring scroll after SVG replacement. Cold-compilation feedback on first loading a large document may still be slow.

A 20-section multi-page fixture was confirmed slower than a short document. Whole-document compilation was accepted as a v1 boundary at the time; this explains the historical tradeoff but has been reconsidered after later performance reports. Missing CJK glyphs were recorded separately as font-coverage issues and were not resolved in this phase.

## M22: feedback while waiting

Source changes immediately set pending, cleared when matching successful rendering arrives. A temporary source hint appears above the cursor and is explicitly distinct from final Typst layout. Short documents may mostly wait for debounce, while long documents wait for real compilation. Repagination occurs in the next whole-document compilation without a separate temporary pagination result.

The short demo and 20-section fixture had manual checks; first-hint delay for large documents remains insufficiently investigated.

## M23: phase-close versus current status

The first part moved paragraph, heading, and list commands to parse → transform → serialize. “P” exits lists; ordered lists starting at 1 use Typst `+`. Some repeated list-switching behavior comes from existing PM commands and is fixed by characterization tests.

Mark/table adaptation was not committed at phase close and was completed later in Phase 4. An asynchronous drag-anchor race was fixed, and positioning from old rendering while pending was rejected. The lack of storedMarks on collapsed selections remains a limitation. A slash menu was never implemented in Live cursor and is now undecided.

## Risks passed to the next phase

Source, layout, and geometry must share a version; whole-document compilation does not remove the need to order asynchronous results. Multiple columns, group transforms, font coverage, long-document display costs, and real input experience all require later acceptance checks. Engineering-experiment success and independent user approval are recorded separately; see [Interaction design](interaction-design.md).

### Phase-ending criteria and handoff checklist

The phase ended because compilation, geometry, native input, and the editing loop each had positive experiments sufficient to proceed to interaction validation. This does not mean the original M15 approach succeeded, all of M23 was finished, or real users had endorsed the product.

- Adopted: persistent World, byte/geometry mapping, composite-view selection, and input foundations.
- Replaced: block swapping and dependent M15b/M17; M16 waiting feedback moved to M22.
- Handed off: remaining M23 tools, real multi-page interaction, font coverage, display-update cost, and product validation.
- Later revised: Phase 4 returned single-block input to native drafts; preview performance reopened on 2026-10-22. Historical “acceptable for v1” status no longer constrains actual lag reported by users.
