# Phase 1: conversion and preview loop (M0–M6)

Status: the phase has ended and feature milestones are complete. This document restores the comparison between original goals, deliverables, and validation evidence. Historical “complete” status does not mean every planned acceptance method has been automated. Document review date: 2026-10-23.

## Goals, scope, and dependencies

Demonstrate a stable `Typst ⇄ Editor Model ⇄ Markdown` conversion loop in Tauri, with previews produced by real Typst compilation. This phase uses rich-text editing and a separate preview; direct input in the final paginated output is not yet required.

The supported subset comprises paragraphs, headings 1–3, bold, italic, inline code, ordered/unordered lists, and hard breaks. Unknown syntax, unexpanded function calls, and top-level settings are also preserved. The subset must be expressible in both source formats and the ProseMirror schema; “stable round trips for a limited subset” must not become a claim of byte-for-byte fidelity for the full Typst language.

File operations, PDF, links, tables, and images were excluded and later entered [Phase 2](phase2-content-io.md). Dedicated equation editing, citations, footnotes, multi-file imports, and full semantic analysis are not outcomes of this phase. Position mapping inside marked text in the old WYSIWYG view only required approximate navigation at the time, not byte-level precision.

Implementation dependencies: establish World/fonts and native compilation first, then schema and conversion, and finally connect and validate the three views. This order brings Typst environment-integration risks forward, avoiding editor expansion before a working preview exists.

## Original goals compared with results

| Milestone | Original goal and acceptance basis | Actual delivery | Deviations, boundaries, and follow-up |
|---|---|---|---|
| M0 Project and compilation environment | Display SVG from hardcoded source in the WebView; validate World and font loading first | Tauri/React/Vite, TauriWorld, compile_typst, and font loading | System-font fallback for CJK came later; embedded fonts are not a complete CJK library |
| M1 Typst source loop | Preview updates after CodeMirror edits, locatable diagnostics, and bidirectional preview/source navigation | Debounced compilation, real diagnostics, and typst-ide position queries | Requires the native backend; click mapping does not imply full selection or structural editing |
| M2 Editor model | Schema represents the full promised subset; manually constructed model fixtures are valid | ProseMirror nodes/marks, raw-source leaf nodes, and fixtures | Preserve out-of-model content rather than expand the subset through forced conversion |
| M3 Bidirectional Typst conversion | Stable parse→model→serialization; the original plan also compared compiled output before and after a round trip | Rust AST parsing, TS AST→model→source, expected-serialization tests, and position-mapping tests | Current frontend tests use AST fixtures without real Rust IPC; a complete real-compilation diff loop cannot be claimed as automatically passing |
| M4 Bidirectional Markdown conversion | Use a real Markdown parser, stable model round trips, and preservation of special Typst content | remark conversion, typed fences, and model-equivalence tests | Structural normalization is supported; byte-identical markers/whitespace are not promised; later tables and image captions introduce separate format losses |
| M5 Three-view integration | Switching WYSIWYG, Typst, and Markdown preserves subset content; previews always come from Typst | Three views, toolbar, and PM-position/Typst-byte-position mapping | Interpolation inside marked/escaped ranges; not direct editing in the final layout |
| M6 Mixed loops and stability | Mixed fixtures, unknown syntax, full three-view cycles, and compilation regression checks | Cross-format pure-logic tests, Rust mixed-document compilation tests, and historical manual smoke records | Automation covers separate layers; a full three-view cycle with real Rust parsing still needs native manual checks, and historical records are not a rerun in this revision |

## Conversion contracts and presentation rules

| Construct | Data contract | Typst / Markdown behavior | Old WYSIWYG behavior |
|---|---|---|---|
| Unknown syntax | `unsupported_block` stores the raw fragment | Raw nodes emit original text; Markdown structures without direct equivalents use fences | Read-only placeholder, without claiming structural editing support |
| Unexpanded function calls | `typst_call { name, raw }`, where raw is the original source slice | Original Typst output; `typst-call` fences in Markdown | Raw calls appear as read-only block/inline items |
| Top-level settings | `typst_set { function, raw }` in a separate settings list | Settings emit before the body; `typst-set` fences in Markdown | Document Settings shows raw settings without simulating their layout effects in the CSS editing surface |
| Local settings and complex semantics | Do not expand the scope semantics of the top-level settings model | Preserve raw source without inferring rule application | Raw-node handling; later Live cursor provides general source input |

Assess three levels of fidelity separately:

1. Supported subset: stable structure and expected serialization, allowing normalized Markdown markers.
2. Raw nodes: unedited raw content must not be silently removed or rewritten by unknown-structure conversion.
3. Whole file: model rebuilding, setting hoisting, and cross-format conversion do not imply whole-file byte identity. Current direct original-format saving belongs to [Phase 4](phase4-product-validation.md).

## Validation methods and reproducible entry points

Run from the repository root in the environment described in [README](../README.md#development-environment). These are review entry points, not claims that tests ran during this revision:

```sh
pnpm test src/model/schema.test.ts src/spokes/typstAst.test.ts src/spokes/markdown.test.ts src/loop.test.ts
cargo test --locked --manifest-path src-tauri/Cargo.toml ast::tests
cargo test --locked --manifest-path src-tauri/Cargo.toml typst_world::tests
cargo test --locked --manifest-path src-tauri/Cargo.toml mixed_document_compiles_successfully
```

| Evidence | What it establishes | What it does not establish |
|---|---|---|
| Schema and TS conversion fixtures | AST→model→expected source, Markdown model round trips, and position helpers | Real Rust parsing integration or identical real rendering |
| `src/loop.test.ts` | Cross-format model equivalence through real remark and stable downstream Typst text | A complete native WYSIWYG→real Typst IPC→Markdown→WYSIWYG cycle |
| Rust ast/world/compile tests | Real parsing, font environment, and successful compilation of specified mixed source | Item-by-item real SVG diffing between TS serialization output and input files |
| Native smoke checks | Actual view integration, focus, clicks, and display | Files, platforms, IME, or long-document scenarios that were not exercised |

### M6 native acceptance procedure

1. Open or enter a fixture containing headings, marks, nested lists, breaks, and raw-source nodes.
2. Switch WYSIWYG→Typst source→Markdown source→WYSIWYG, comparing structure and text item by item.
3. Check that raw calls/settings remain and supported content is not duplicated, omitted, or incorrectly merged.
4. Compare real previews from each view and exercise source→preview and preview→source navigation.
5. Enter an invalid call, confirm diagnostics appear, then fix it and verify preview recovery without a crash.
6. Record the fixture, platform, fonts, build, and failures. Usability with short MVP documents is not acceptance of long-document performance.

## Risks and phase handoff

The common subset of two formats limits structural expression; preserving unknown syntax is necessary for a stable loop. Pin typst-ide and core versions together and recheck position interfaces after upgrades. Font environments affect rendering comparisons and should be recorded rather than attributing every difference to the editor.

Phase 2 takes on real files and content expansion; Phase 3 takes on single-view feasibility, performance, and range geometry. This phase establishes reusable conversion and compilation foundations, without promising completion of subsequent interaction work.
