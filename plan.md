# Project plan

Document review: 2026-10-23. This document records goals, progress, and next steps only. The topic documents below cover interaction specifications, implementation comparisons, and validation evidence. This is a documentation revision; it makes no new claim of passing tests or product delivery.

## Goals and scope

Provide a desktop editing experience that directly displays Typst's compiled output for writers who already know Typst. In Live cursor, unfocused blocks show compiled output, while the focused block uses a native textarea for source editing. This is still different from editing text directly in its final layout. Full WYSIWYG remains a long-term goal.

Markdown remains a first-class file format and must support genuine bidirectional conversion. There are still four tabs: WYSIWYG, Typst source, Markdown source, and Live cursor. The old WYSIWYG view is the default; consolidation has not been implemented.

## Phase progress

| Phase | Status | Capabilities established |
|---|---|---|
| [Phase 1: M0–M6](doc/phase1-mvp.md) | Complete | Conversion between Typst, Markdown, and the structured model; real previews, diagnostics, and position mapping |
| [Phase 2: M7–M12](doc/phase2-content-io.md) | Features complete; gaps remain in historical M12 interaction acceptance records | File operations, PDF, links, tables, images, and the old editing surface's toolbar |
| [Phase 3: M13–M23](doc/phase3-single-view.md) | Engineering validation ended on 2026-09-09 | Persistent World, geometry queries, CJK input experiments, custom cursor, and cross-block selection; M15's mixed-layout approach was not adopted; M23 moved into Phase 4 |
| [Phase 4: interaction and product validation](doc/phase4-product-validation.md) | In progress | Native block editing, toolbar, cross-block history and navigation, definition navigation, autosave, and last-successful-output retention on compilation failure; independent user validation has not begun |

## Recent work implemented

- Saves, autosaves, PDF exports, and unsaved-change prompts include drafts that have not lost focus. Autosave waits for IME composition to end, and disk writes follow request order. Cross-block copy, cut, and paste use the actual source selection; cut and paste are independently undoable.
- Live cursor's duplicate right-hand preview has been removed. Inactive views and native focus mode issue fewer unnecessary geometry queries; SVG content extraction is cached by result. The entire SVG is still generated, transferred, and replaced, so end-to-end latency remains open.
- This round fixed clipping misalignment caused by inconsistent SVG width/height units; unified page width and proportional focused-block sizing; and included textarea borders in height measurement, with height updates after width changes.
- This round fixed the window remaining open after exit confirmation by adding Tauri's window-destruction permission. Regression tests use the SDK's actual close-event flow and cover confirmation, cancellation, and closing without changes.
- The workspace also contains uncommitted preview optimizations: request coalescing and stale-result rejection, optional per-page delta output, page DOM reuse, and stage timing now have code. The default remains merged mode. This parallel work has not completed native acceptance checks for page mode and does not count as resolving the performance issue.
- Existing backend/browser experiment data has been found and [the raw observations archived](doc/benchmarks/2026-10-22/README.md). Timing boundaries and result comparisons are in the performance document. These were not rerun in this revision and do not establish overall speed relative to Tinymist under matched conditions.

**Validation boundaries:** Passing frontend test records exist for the 344-test fix baseline on 2026-10-22 and a later 347-test snapshot containing page tests, alongside TypeScript/production build records from that time. This does not mean tests were rerun for this documentation revision or that all subsequent workspace code is verified. That day's Release checks covered real Typst short-document clipping, the focused textarea, and clean closing. Unsaved-change confirmation/cancellation has SDK-flow regression coverage but still lacks a new native-dialog acceptance check. Multi-page layout, IME, and system clipboard behavior need rechecking. The 98 Rust test record belongs to an earlier stage and is not a result from this run.

## Next steps, in order

| Order | Work | Completion criteria |
|---|---|---|
| 1 | Native application regression checks | Follow the Phase 4 acceptance matrix for clipping, drafts/IME, clipboard, exit confirmation/cancellation, and error recovery; record the build, fixtures, actual results, and uncovered cases |
| 2 | Consolidate the four tabs | Current proposal: default Live cursor with separate Typst/Markdown source entry points; define entry points/shortcuts/return behavior first, then verify Markdown capabilities, structural operations, and saves without regression before removing old entry points |
| 3 | Optimize preview updates after editing | Measure latency from commitment to first display and neighboring-block stability; separate compilation, SVG, IPC, DOM, and paint costs; implement compiled-result reuse, request coalescing, and page updates according to measurements |
| 4 | Product and writing capabilities | Target-user validation; equations, citations/bibliographies, and footnotes; interface cleanup and an accessible text layer |

Consolidating the four tabs is the next main task after acceptance checks for this round's fixes, ahead of autocomplete and hover highlighting. There is no confirmed completion date. Performance measurement can proceed alongside consolidation design; completing all long-term performance work is not a prerequisite.

“Next main task” describes the current order; the specific source entry points remain a design proposal. Existing gaps such as Shift selection across blocks must not be presented as new capabilities. Whether they block migration should depend on data/save/basic-editing regressions and an explicit migration acceptance scope, rather than waiting for every long-term feature.

## Explicit outstanding items

- Shift+Up/Down selection extension across blocks, cross-block IME composition feedback and candidate-window positioning, and an application-history memory limit.
- Compilation-error display without any previous successful result, changing block counts during errors, multi-page clipping, and blur ordering when clicking a neighboring block directly. Visible blocks may continue showing placeholders after geometry-cache invalidation.
- Splitting triple-backtick code fences; geometry for same-baseline text in multiple columns and for rotation/scaling; position-mapping precision inside marked text.
- Declaration autocomplete has a design only, with no code. Definition-to-usage navigation and `#set` effect ranges are unimplemented. World does not support multi-file imports yet.
- [Preview hover highlighting](doc/preview-hover.md) has been investigated but is unimplemented. A Live cursor slash menu remains undecided and is excluded from v0.1.
- Font coverage for some CJK glyphs needs further checking. System-font fallback does not mean a complete CJK font library is bundled.
- Node 22.11.0 is below the current Vite requirement, and production builds report a bundle-size warning. Upgrade Node and decide on code splitting using actual loading measurements.
- Autosave overwrites an existing path directly, without a separate crash-recovery file; this choice has not been validated with users.

## Documents and artifacts

| Document | Responsibility and reading entry point |
|---|---|
| [Interaction design](doc/interaction-design.md) | Product tradeoffs, states/events, exceptional behavior, keyboard behavior, and 15 acceptance scenario categories; numbered decisions serve only as an index |
| [Phase 1](doc/phase1-mvp.md), [Phase 2](doc/phase2-content-io.md) | Goals/results/deviations, format-fidelity boundaries, historical M12 acceptance gaps, and review methods |
| [Phase 3](doc/phase3-single-view.md) | Evolution of engineering approaches, experimental conditions/commands, negative results, and handoff |
| [Phase 4](doc/phase4-product-validation.md) | Plan/result comparison, evidence by validation level, native acceptance matrix, and independent user validation |
| [Architecture](doc/architecture.md), [Design principles](doc/design-principles.md) | Current responsibilities, interface/data contracts, technical tradeoffs, and correctness constraints |
| [Performance analysis](doc/preview-performance.md), [Hover investigation](doc/preview-hover.md) | Measurement methods and unfinished optimizations; historical investigation separated from implementation status |

Reporting conventions: **implemented** means code exists; **automated checks passed** identifies the check type, snapshot, and scope; **native acceptance** identifies the build/platform/fixture; **user validation** requires records of target-user tasks. Ending a phase does not mean every detail has been accepted. Test totals, milestone numbers, and complete links cannot by themselves prove that the documented capabilities are complete.

See [README](README.md) for running the project, dependencies, and build artifacts. A fixed Release exe was generated this round; MSI/NSIS packages are still old. The exe corresponds to the 2026-10-22 23:51 build snapshot and does not include all subsequent parallel changes; updating `dist/` does not automatically update an existing exe.
