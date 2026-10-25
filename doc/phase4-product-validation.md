# Phase 4: interaction implementation and product validation

Document review: 2026-10-23. The core mechanism is integrated into the main Live cursor implementation; independent target-user validation has not begun. This document consolidates plans, actual results, evidence, and limitations. This is a documentation-only revision; test totals and native checks below are existing execution records, not results rerun here.

## Phase goals and completion criteria

This phase moves from “technically able to edit real rendering” to “reliable input behavior that users understand and are willing to adopt.” Engineering and product validation are separate tracks: the former requires no data loss, correct focus/selection/saving, and real compilation and native scenarios; the latter observes whether target users can complete writing tasks, accept source blocks, and benefit from real layout. Passing the former cannot replace the latter.

The baseline is Phase 3's whole-document SVG composite view, where every input modifies source and compiles, and even single-block editing uses a custom cursor. Phase 4 aims to retain cross-block geometry while assigning ordinary input to native drafts. Reusing existing results rather than rebuilding a second production editor is part of the implementation scope.

| Original plan/work item | Actual result | Evidence or deviation | Follow-up |
|---|---|---|---|
| Spike 1: understandable single-block focus/blur | Switching between a native source block and real compiled output works | Manual checks found width mismatch, select-all, and Escape semantics issues; positive after correction | Apply rules to the main mechanism without inferring validation of all long documents |
| Spike 2: neighbors, selections, and global layout | Switched to cropping one whole-document result, retaining paragraph/page margins | Independent compilation loses global context and displays old content; fixed overlays cover later content | Abandoned independent compilation and overlays rather than retaining them as pending features |
| Splitting review and Spike 3: blank lines, selection extension, and continuous writing | Bracket-depth splitting; lazy preferred to eager; handoff after mouse release | 13 splitting tests are a historical record; mid-drag handoff passed mocks but failed natively, then was corrected | Triple backticks and complex syntax remain open; heuristics are not full syntax parsing |
| 2026-09-11 Main integration | Native blocks added to TypstLiveView, followed by a focused-state toolbar | Implementation remains in the existing component; full early multi-page support, navigation, and references were not completed together | Record later increments by date without backdating initial integration scope |
| 2026-09-14 Geometry and scrolling | Lazy queries, invisible-block distinction, batch Frame traversal, and focus scroll protection | Real multi-page performance issues led from frontend mitigation to backend batching | Visible placeholders that do not requery, group transforms, and multi-column boundaries remain |
| 2026-09-15 Everyday editing | Cross-block history, B/I, ordinary vertical block navigation, and definition navigation | Unit tests and historical native records; Shift extension across blocks and reverse references excluded | Retain keyboard/source-position precision gaps rather than claim full editing parity |
| 2026-09-16 Autosave | Write directly to an existing path after a pause | Mechanism choice lacks user-research validation; no separate recovery file | Unblurred drafts and composition protection added on 2026-10-22 |
| 2026-09-17/18 Compilation-error fallback | Retain last successful output and failing block source/diagnostics | Primarily mocked interaction; not local error-tolerant compilation | Initial failure, multiple errors, block-count changes, and real recovery still need acceptance checks |
| 2026-09-18/19 Long documents | Retained historical backend measurements; fixed three sources of duplicate frontend work | Issue initially closed from backend figures; later real lag showed insufficient evidence | Reopened overall latency, preserving old data while withdrawing excessive conclusions |
| 2026-10-22 Drafts, clipboard, clipping, and closing | Current source contains fixes, regression tests, and partial Release native checks | Real OS clipboard and dirty-exit dialogs still lack native rechecks in this round | Continue with the UI scenarios below; fix-baseline evidence does not cover parallel code |
| Unified entry points and independent user validation | Not implemented/begun | Four tabs remain; source entry design incomplete; no target-user task results | Next step; component integration or a working demo does not mean product validation is complete |

## Current delivery

| Capability | Implementation status | Validation boundaries |
|---|---|---|
| Native source editing in focused blocks; commitment on blur | Implemented in existing TypstLiveView | Early real compilation and native interaction validated; multi-page clipping still has uncovered scenarios |
| Structural toolbar, marks, tables, and Ctrl+B/I | Implemented | Native manual records and unit tests; collapsed-selection marks remain ineffective |
| Cross-block history, vertical navigation, and definition navigation | Implemented | Historical native baseline validated; Shift+Up/Down selection extension across blocks unimplemented |
| Autosave | Implemented; writes directly to existing files | Historical baseline checked; latest unblurred-draft/composition protections add mocked-backend regression coverage and await native rechecking |
| Successful-result retention on compilation failure | Implemented | Mainly mocked-backend interaction validation; real engine, multiple errors, and block-count changes need review |
| Unblurred-draft save/export and cross-block clipboard | Completed on 2026-10-22 | React DOM + mocked IPC; real system clipboard and IME pending |
| Long-document duplicate computation and SVG copying | Reduced | Cache/single-master regressions; separate backend/browser experiments exist, but current native commitment-to-presentation acceptance is missing |
| SVG clipping, textarea sizing, and exit permission | Fixed this round | Unit tests, mocked-SVG browser checks, and Release real short-document/clean-close checks passed; dirty native confirmation pending |
| Request scheduling, stage timing, and optional page preview | Uncommitted parallel development | 347-test frontend regression record for a 2026-10-22 workspace snapshot; later-added tests are not results from this revision, and native acceptance is missing |
| Four-tab consolidation and full writing capabilities | Unimplemented | Prioritize tab consolidation after acceptance of this round's fixes |

## Spikes 1–3: establishing the interaction mechanism (2026-09-10)

Adopted: clicking a block displays its real source in a native textarea. Blur, Escape, or block switching commits and returns to Typst output. Other blocks crop the same whole-document SVG; growth of the focused block pushes later content through normal document flow.

| Experiment/problem | Conclusion or correction |
|---|---|
| Focus width at 100% of container | Align with actual SVG width and content boundaries; do not select all source on focus |
| Escape discards draft | Inconsistent with other exit paths; unify on commitment |
| Compile every other block independently | Loses global settings/context and produces default whole-page heights and wrong content; crop one whole-document result instead |
| HTML export or fixed overlay | The former is not the same visual layout; the latter covers following content as it grows; neither adopted |
| Crop only text bounds | Page/paragraph spacing collapses; allocate space at neighboring text midpoints, extending ends to page margins |
| Fetch geometry asynchronously after focus | Misaligned first frame; obtain focused/neighbor geometry before switching atomically |
| Split immediately on blank-line input (eager) | Neighbor blocks repeatedly return to pending during continuous writing; split on blur (lazy) |
| Incorrect split on blank lines inside table cells | Extract depth-aware splitter, splitting only at top-level blank lines and skipping strings, comments, and single-backtick content |

The splitter gained 13 tests at the time, covering tables, figure, lists, comments, strings, and CJK byte ranges; triple-backtick fences were not handled. Spikes remain experimental material, without further standalone product polishing. The main mechanism entered TypstLiveView on 2026-09-11; no second production editing component was created.

## Cross-block dragging: a root cause missed by mocked tests

Initially, dragging out of the textarea committed immediately and switched to the SVG composite view. Source textareas and Typst have different heights and line spacing, so the switch changes content under the pointer. Continued coordinate conversion may land in blank space, resembling “closing and reopening.”

An initial pending bypass passed with simulated compilation latency but still failed in the real application. The final approach records boundary crossing, commits after mouse release, waits for rendering matching `expectedSource` with pending cleared, then resolves the final landing point. This correction had manual real-compiler validation. Later asynchronous focus uses increasing request numbers to prevent slow earlier clicks from overriding later clicks.

## Geometry and scrolling (from 2026-09-14)

Prioritize the focused block and neighbors; query other blocks when they enter the IntersectionObserver region, retain estimated heights, and restore scroll before layout commitment. Unknown geometry is distinct from confirmed invisible content. Empty blocks such as `#set`/`#let` occupy no clipping height and are skipped when finding neighbors, preventing permanent placeholders and contaminated neighbor boundaries.

Early per-range whole-tree traversal cost “range count × glyph count.” The backend now traverses in batches: sorted byte ranges determine glyph ownership; images/shapes still compare against each range, assuming no overlap. The old complexity description therefore does not apply to current batch text queries. Each query still compiles and traverses the document, without a shared final-document cache.

Scrolling had two causes: short placeholders moved content positions, and focusing the hidden input scrolled to the document top by default. Mitigations respectively estimate placeholder heights from bytes/known geometry, restore scroll, and use `preventScroll`. Still-visible blocks may not retrigger the observer after cache invalidation and need active refresh.

## Toolbar, navigation, and positions (2026-09-15)

Structural commands use a temporary PM document, then return to the native block and restore the source cursor. Toolbar/definition-button mousedown prevents default focus theft so blur commitment/unmounting does not precede click. UTF-16 and byte offsets had been mixed; serialized leaves and join lengths now consistently use UTF-8. Mapping inside marked ranges remains imprecise.

Ordinary Up/Down first lets the browser move within the textarea. Only if the next frame confirms the collapsed cursor did not move does navigation cross blocks, using committed byte positions to avoid changed block counts from new blank lines. Shift extension retains native within-block behavior only.

Above the focused block, actual referenced variables, imported bindings, and labels are listed, with clicks navigating to definitions. This is not complete multi-file support and excludes `#set` style effects and definition-to-usage lists. Declaration autocomplete has a design only; see [Interaction design §10](interaction-design.md#10-结论与下一步).

The rationale for typst-ide is scope semantics, not hiding name-matching limitations: deref_target/definition identify references, named_items handles ancestor and preceding bindings, and labels depend on the compiled document's Introspector. Same-named local variables must resolve to the currently visible definition, not the first matching string in the document. `src-tauri/src/references.rs` tests same-name scopes, label targets, invalid references, standard-library omission, deduplication, and current-subtree-only handling.

This also explains why #set is not simply “one missing reference kind”: it creates no name-queryable binding, and its effect propagates implicitly through position and scope. Tracking “which rule affects this block” requires a different analysis. Existing usage-to-definition navigation must not be described as a full rule-effect index or declaration autocomplete.

## History and saving

`editHistory.ts` uses consecutive edit diffs and snapshots for structural operations; adjacent text within 500ms may merge. Focused native blocks use browser undo first, then application history if the next frame confirms no change. Even returning to the same block remounts through focusGeneration and restores focus. No-ops do not enter history; document generations reset history on document switches.

There is no history memory budget yet, nor a guarantee of restoring the exact pre-edit cursor. Cross-block cut/paste uses isolated history boundaries to avoid merging with surrounding typing.

The autosave baseline was implemented on 2026-09-16: with an existing path, write the original file after 2000ms without input. There is no recovery file; untitled documents still need a manually chosen path. Further work on 2026-10-22 added:

- LiveDraft snapshots include the uncommitted current block. Dirty state, saves, exports, and leave protection read current text; compilation still reads committed source only.
- Original-format saves write text verbatim without parse/serialization; cross-format saves still convert.
- Autosave pauses during IME composition, with composition state independent of potentially inaccurate InputEvent flags.
- Disk writes are queued; document generations and save snapshots prevent old requests from marking subsequent input/new documents clean.
- Saving does not commit drafts, trigger compilation, or reset focus or native undo.

The corresponding commit is `65f8e73`; latest native behavior awaits rechecking. Subsequent `be976bd` reduced duplicate Live cursor previews and geometry/SVG processing.

## Compilation-error handling (2026-09-17/18)

Original problem: one block's compilation failure removed SVG and geometry for the entire document, making other blocks unusable. Latest diagnostics are now separate from the last successful result/source:

1. Failure does not replace successful SVG.
2. Prefer the last edited byte when choosing the failing block, falling back to diagnostic ranges as needed; parser recovery may report syntax errors at the document end.
3. The failing block shows source and red diagnostics; Locate enters that block directly.
4. Other blocks use successful-source geometry; never crop old SVG with ranges from failed new source.

Limitations: this is not local compilation. Until global errors are fixed, later valid edits cannot render either. Initial failure, multiple errors, block-count changes, and complex pagination still need real-engine acceptance checks.

Paths considered but not adopted:

| Path | Reason not adopted |
|---|---|
| Temporarily patch/mask failing source and recompile | Dependencies and cascading errors make even two attempts unreliable; bracket-depth changes invalidate masking ranges |
| Automatic syntax correction | May change author intent; no reliable general correction rules |
| Switch everything to source | Loses existing visual context in other blocks |
| Fork Typst evaluator and catch failures locally | Requires maintaining top-level evaluation, binding failures, and later layout errors; more than catching one exception |
| Introduce typed-hole semantics | Research such as Hazel is informative but requires language-level error-tolerant semantics, not a short-term patch for this version |

The choice is therefore to retain successful output while clearly exposing errors and limitations. Research reference: [Hazel paper](https://doi.org/10.1145/3632910).

## Performance records: retain measurements, revise conclusions

### Historical backend measurements

| Release fixture | `compile_typst` record |
|---|---|
| 14 pages | Approximately 73ms |
| 34 pages | Approximately 156ms |
| 100 pages | Approximately 489ms |

These measure backend calls, including compilation/output costs within the call boundary at the time, but excluding frontend post-IPC processing, DOM, and painting. They are neither pure Typst compilation microbenchmarks nor overall commitment-to-display latency. The performance effort was closed on 2026-09-18 on this basis, a conclusion overturned by later real lag reports.

### 2026-09-19: three sources of duplicate frontend work

| Problem | Correction and evidence |
|---|---|
| Encoding the whole document for every byte-to-UTF-16 conversion | Encode only the prefix bounded by byteOffset; tests inspect actual encoded input length; still not constant-time lookup |
| Repeated whole-source block scans within a render | Cache the block array by identical source; tests check reference reuse |
| Copying the entire SVG into every crop DOM | Mount master once and reference it from crops through `<use>`; tests/browser checks find only one content copy in author DOM |

Real output fixtures: approximately 3.2MB for 14 pages and 7.9MB for 34 pages. More than ten visible crops previously copied tens of MB of markup. The fix reduces author DOM duplication without establishing viewport virtualization in the browser.

Measured optimized line-breaking costs with justify: 14 pages 55→76ms (approximately +38%), 34 pages 144→167ms (approximately +15%). These are specific-fixture data, not justification for disabling justification or reducing layout precision. Future measurements must record justify settings.

The record at the time was 316 frontend tests, 98 Rust tests, and clippy passing; these are historical execution results.

### 2026-10-22: renewed investigation of post-edit preview latency

The user specifically reported slow Live cursor preview updates after editing. Duplicate right-hand preview was removed; unused interaction geometry queries in inactive/native-focus states were disabled; large SVG content extraction was cached. The frontend baseline reached 339 tests. Commitment-to-display and neighbor-stability timing, compiled-result reuse, request coalescing, and page/scene updates remain necessary; see [performance analysis](preview-performance.md).

## Screenshot issues and exit fixes in this round

- SVG viewport width used unitless px while height used pt. The viewport/viewBox aspect ratios differed, creating extra space under aspect-ratio preservation and allowing neighboring content into the wrong crop. Width/height now both use pt with explicit overflow limits.
- Cropped and focused blocks share a page width. Extra crop padding was removed; focus width/margins are proportional, and window resizing does not remount the input.
- textarea uses border-box, but scrollHeight excludes borders. Height now includes borders and is remeasured after actual width changes, removing unnecessary internal scrollbars for short drafts.
- Default permissions omit window destroy, so the SDK's automatic call after close confirmation was rejected. The main window now has `core:window:allow-destroy`, preserving unsaved-change prompt semantics.
- Outdated engineering hints and tab milestone numbers were removed. The example no longer claims all views always share a single state.

The fix baseline passed 344 frontend tests; after workspace page-protocol tests were added, the count was 347. TypeScript and Vite production builds passed. The Release exe was checked with real short-document clipping, focused textareas, and closing without changes. Unsaved-change confirmation/cancellation has SDK-flow regression coverage; this round's native dialogs, multi-page behavior, system clipboard, and IME remain unchecked.

Concurrent uncommitted preview code adds request coalescing/stale rejection, backend stage timing, page deltas, and page DOM reuse; default mode remains merged. An optional Release benchmark also exists. There is no new end-to-end latency conclusion, so the existence of this code is not performance acceptance. The fixed exe corresponds to the 23:51 build snapshot and does not include all subsequent workspace changes.

The 2026-10-23 documentation review also found existing independent experimental artifacts: 81 backend observations, 9 browser replays each for merged/paged, and another set of Tinymist observations. Small raw JSON files were [archived with provenance](benchmarks/2026-10-22/README.md); medians and timing boundaries are in [performance analysis](preview-performance.md#discovered-experimental-observations-and-their-boundaries). They add result comparisons but lack complete environment/build information. Browser replay and file-write timing are also not equivalent, so they establish neither overall speed ratios nor passing native acceptance.

## Next steps and acceptance scope

After acceptance of current fixes, the next main task is consolidating the four tabs. Default Live cursor with separate source entry points is the current proposal; presentation and switching rules remain to be designed. Retain Markdown files and conversion. This precedes academic-specific controls, declaration autocomplete, and hover highlighting without cancelling those product needs.

Continue acceptance checks for native IME/system clipboard, close confirmation/cancellation, recovery with frozen rendering, initial failure/block-count changes, multi-page clipping, and blur ordering on direct block switches. Product validation still needs target users to evaluate the value of real rendering, acceptance of source editing, and save/recovery expectations. Engineering tests cannot replace interviews or usage observation.

### Validation levels and existing records

| Level | Current evidence | Conclusions that cannot be extrapolated |
|---|---|---|
| Pure logic/conversion | Schema, splitting, offsets, history, structural commands, and format-conversion tests | Does not establish IME behavior, dragging feel, OS clipboard, or visual page correctness |
| React DOM + mock IPC | App draft/save/clipboard/close flows and preview-scheduling tests | Does not establish complete real filesystem/compiler/Tauri permission/system-dialog paths |
| Rust real engine | AST, fonts, compilation, geometry, definitions, and PDF tests | Does not establish WebView clipping/focus order or cover the full TS/Rust round trip |
| Browser layout fixture | Mocked SVG/IPC clipping ratios, single master, and draft resizing checks | Does not establish real Typst layout, multi-page relationships, or actual exit permissions |
| Native history and 2026-10-22 Release checks | Historical single-block mechanism/partial multi-page operations; new short-document focus clipping, no unnecessary short-textarea scrollbar, and clean close | Does not cover new dirty confirmation/cancellation, all IMEs/multi-page cases, or parallel page code |
| Target-user validation | No independent task records yet | Cannot mark interaction as meeting target-user expectations |

316 frontend/98 Rust/clippy is a historical 2026-09-19 record. 335 is the frontend record after draft/clipboard fixes; 339 follows duplicate-work reductions; 344 is the clipping/exit-fix baseline; 347 is a later snapshot containing page tests. Counts must carry dates, code scope, and methods; later workspace growth cannot be inferred as executed and passing. This documentation revision did not rerun those tests.

### Reproducible automated-check entry points

Run these from the repository root; see [README](../README.md#development-environment) for environment requirements. Test names match current code; readers should record their own results rather than inherit historical counts.

```sh
pnpm test src/App.test.tsx src/editor/blockSplit.test.ts src/editor/splitLayout.test.ts src/editor/editHistory.test.ts src/editor/structuralCommand.test.ts
pnpm test src/editor/pagePreview.test.tsx src/editor/usePreviewCompiler.test.tsx
cargo test --locked --manifest-path src-tauri/Cargo.toml geometry::tests
cargo test --locked --manifest-path src-tauri/Cargo.toml references::tests
cargo test --locked --manifest-path src-tauri/Cargo.toml page_preview::tests
```

Synthetic composition events suit regression checks of composing branches, not replacement of real Chinese/Japanese/Korean input. SDK close-callback tests cover asynchronous prompts and capability contracts, not real dialogs. Test entry points for uncommitted preview code serve development checks, not proof of native page-mode acceptance.

### Native acceptance matrix

See [Interaction design §6](interaction-design.md#6-核心交互机制聚焦块编辑源码) for full behavior requirements. Shared IDs connect specifications and evidence, avoiding vague claims that “tests exist” without identifying what they test.

| Scenario | Fixture/method | Existing evidence | Native validation still needed |
|---|---|---|---|
| UI-01 Focus and sizing | Short demo; focus final paragraph, Escape, resize window | Mock layout, 344-baseline regression, Release short-document observation | Focus/history with different font sizes, window sizes, and repetitions |
| UI-02 Split/clear | Paste paragraphs in a middle block; clear block/whole document, then undo | Partial splitting/history unit tests | Complete results for zero-length ranges, all-blank documents, and neighbor positioning |
| UI-03 Unknown syntax | Blank lines inside tables/figure, multiline show/calls, triple backticks | Bracket-depth tests and raw-node conversion tests | Known fence gap; compare all raw fragments before/after structural tools |
| UI-04 Block-switch races | Edit/split A, rapidly click B/C | Historical blur/asynchronous-focus fix records | Native click/blur ordering and final target; a final screenshot does not establish absence of races |
| UI-05 Cross-block dragging | Both directions, CJK/emoji, compilation waits, and page boundaries | Historical native basis for release-before-handoff fix; DOM selection regressions | Long documents, pending compilation, and scrolling together in the latest build |
| UI-06 Clipboard | Multi-block copy/cut/paste followed by typing and undo/redo | App.test.tsx mocks with ClipboardEvent | Exchange text/plain with system/other apps; verify no duplicate insertion and independent history |
| UI-07 IME | Pinyin candidates, Japanese conversion, Korean consecutive syllables, composition cancellation | M18 prototype/native-block history; latest autosave-composition branch regressions | Real lifecycle in current product controls, across app switches and saving |
| UI-08 Navigation and focus | First/last lines, short/long lines, Tab, Escape, app switches | Navigation pure logic and partial native records; Shift cross-block extension unimplemented | System focus, IME candidate key interception, and composition-state key priority |
| UI-09 Undo and redo | Exhaust native history, structural commands, typing after cut/paste, switch documents | editHistory/App regressions and historical native records | Exactly-once native/application undo; no old history entering a new document |
| UI-10 Save/export | Unblurred edits, manual/autosave, failures, and late old requests | Mock fs/invoke race/draft regressions | Real file writes, PDF, cancellation paths, and focus/native-history retention |
| UI-11 Open/exit | Cancel opening with drafts, Yes/No closing, and clean close | SDK's real onCloseRequested flow; Release clean close | Final window/text state after dirty Yes/No in the latest native build |
| UI-12 Error recovery | Initial failure without successful output; failure after success; split/delete blocks during errors | Frozen-result implementation and mock scheduling/error regressions | Real parser-recovery ranges, multiple errors, block/page-count changes; preserve source rather than merely appear to have a preview |
| UI-13 Definition navigation | Same-named local bindings, labels, undefined references | Rust references tests and historical native navigation | Complex scopes and discoverability of invisible declarations; reverse references/#set excluded from existing delivery |
| UI-14 Multi-page layout | m21-multipage-test.typ; focus later pages, scroll, narrow window | Partial historical multi-page fixes; new short-document sizing regression | Full flow in new build, invisible-block neighbors/still-visible placeholders/cross-page ranges |
| UI-15 Requests and page versions | Continuous input, directory/document switches, old results, baseline mismatch | New scheduler/page unit tests in workspace | Native merged/pages consistency across success/failure/recovery and actual display cost |

Each new record must identify at least build revision/artifact time, platform and WebView/fonts, fixture, steps, expected/actual results, evidence files, and remaining issues. Mark unexecutable items pending, not “passed.” Reproduction material is in [test-fixtures](../test-fixtures/README.md).

### Independent completion criteria for product validation

User interviews/observation should have target users perform real browsing/navigation, continuous input, structural changes, saving, and error-recovery tasks. Record understanding and obstacles around source-block switching, waiting feedback, original files, and recovery. Do not merely ask whether users “like WYSIWYG” or treat engineering-demo success as proof of demand.

Sample size, recruitment, and success criteria remain undefined and must be set before the study; this document invents no interview results. Tab-consolidation entry points also need task-based validation; removing three buttons alone does not complete interaction acceptance.
