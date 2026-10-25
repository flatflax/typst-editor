# Live cursor preview performance after editing

Updated: 2026-10-23. The user has specified that the slow operation is **Live cursor preview updates after editing**, not startup or opening files in general. This issue remains open. Previously archived benchmarks and newly executed benchmarks are separated below; isolated stage experiments are not full product acceptance.

## Implementation differences from Tinymist

| Stage | This project's default merged path | Investigated Tinymist version |
|---|---|---|
| Trigger | Wait 150ms after native block draft commitment, then compile | Configurable; defaults to onType |
| Compilation | Persistent TauriWorld, Source::edit, Typst/comemo caches | Persistent compilation actor and state |
| Output | Generate the whole svg_merged on every success | IncrSvgDocServer maintains state, usually using pack_delta |
| Update | Replace master content with a whole-document SVG string over IPC | Rendering actor coalesces queued updates and sends incremental data |
| Display | Master contains all pages; crops reference it through use | Supports partial rendering, documented as enabled by default |
| Geometry | Separate queries with recompilation/traversal; jump still creates a new World | Reuses compiled document and rendering state |

The key distinction is **incremental compilation** versus **incremental output, transfer, and display**. The latter stages in this project's default path still mainly process whole-document results; attributing the issue generally to SVG or “no incremental compilation” is inaccurate. The new optional page path in the workspace is described separately below, without folding it into established completion claims.

The investigation pinned revision `31c3057ec2a9aed81f08256166d1ec2de2e0189a`: [RenderActor](https://github.com/Myriad-Dreamin/tinymist/blob/31c3057ec2a9aed81f08256166d1ec2de2e0189a/crates/typst-preview/src/actor/render.rs#L99), [configuration](https://myriad-dreamin.github.io/tinymist/config/neovim.html), and [compilation/rendering responsibilities](https://myriad-dreamin.github.io/tinymist/principles.html). These were the investigation's sources, not a guarantee that later implementations remain unchanged.

## Duplicate work already reduced

2026-09-19: offset conversion encodes only necessary prefixes; block-splitting results are cached; per-block whole-SVG copies were replaced with one master and use references.

2026-10-22, commit `be976bd`: removed Live's duplicate right-hand preview; disabled inactive Live master/composite geometry; skipped unused custom-cursor queries for native focused blocks; cached SVG content extraction by result. The frontend test baseline was 339.

These changes demonstrate fewer duplicate calls and less DOM content, without millisecond-level overall speedup data for real long documents. Single-master crop references also do not imply page virtualization: whether the browser still processes the full scene must be measured.

## Implementation in parallel development

The workspace contains additional uncommitted code: `usePreviewCompiler` coalesces pending requests, permits one in flight, and rejects stale results; `PagePreviewCache` exports deltas from whole-page fingerprints and sends full pages on baseline-version mismatch; the frontend retains unchanged page DOM and rewrites page-local IDs/references to isolate definitions.

Default mode remains merged. pages mode is selected through `?preview=pages` or the local `typst.preview.mode` setting. Page updates are not viewport virtualization and do not yet reuse the final document to remove repeated jump/geometry compilation. Independent experimental observations appear below; native acceptance of the mode as a whole remains incomplete, so no product end-to-end speedup ratio is established.

New bounded local timing records and an optional Release benchmark separate backend lock wait, source update, compilation, fingerprinting, and SVG. Frontend timing records round trips, application, commitment, paint opportunities, and crop stability. Double requestAnimationFrame paint opportunities are proxies, not actual screen presentation times. Response-byte measurement runs only when timing is explicitly enabled and does not record document bodies.

Page-mode crops also reference intersecting pages rather than necessarily the entire master, reducing the scope expanded by each reference. Hidden page scenes remain mounted, so this is not viewport-based unmounting of all offscreen DOM. Actual savings require real page-data measurements, not inference from component names.

## Measurement contract: what each number answers

| Observation | Start/end or meaning | Invalid inference |
|---|---|---|
| Input response | Keystroke/composition input to native draft display | An immediately visible draft does not mean the final preview has updated |
| Commitment to preview | Blur/structural commitment begins to corresponding successful result visible; record neighbor stability separately | Measure separately from file opening, cold start, and focus-entry geometry waits |
| debounce_ms / queue_ms | Trigger to task runnable; runnable to actual dispatch | Policy wait and queueing respectively; do not merge them into compilation time |
| lock_wait_ms / compile_ms / svg_ms | Backend lock, Typst compilation, output generation; source sync/page fingerprints separate | compile_ms alone omits other large costs; overlap follows current implementation boundaries, so do not sum blindly |
| roundtrip_ms / transport_residual_ms | invoke round trip; residual after subtracting recorded backend costs | Residual also includes serialization, scheduling, and main-thread work; not pure IPC transfer |
| response_bytes | JSON-encoded size in explicit timing mode | Comparable response-body proxy, not actual wire bytes including all protocol headers |
| apply_ms / commit_ms | Page-delta application and stages through React layout commitment | DOM commitment does not mean the user has seen the frame |
| paint_opportunity_ms | Timing proxy after double requestAnimationFrame | Not compositor presentation time or real per-frame first-display latency |
| crops_settled_ms | Tracked crop stability at current measurement markers | Identify participating visible ranges; do not extrapolate to all pages |

Timing is a local development tool, off by default. The current switch is localStorage `typst.preview.metrics=1`; read samples from `window.__typstPreviewSamples`, with at most 100 retained. Reload and inspect within the same build/mode. Recording time itself costs work and should be cross-checked against untimed subjective experience and performance profiles.

### Preconditions for comparable experiments

1. Fix code revision, Release build, CPU/power state, OS/WebView, window size, zoom, and system fonts.
2. Fix source, actual page count, font size, page settings, and justify; section count is not page count.
3. Make the same edit at the same location; measure beginning/middle/end, cold first run/warmed runs, and compilation success/failure/recovery separately.
4. Use the same document/input sequence in merged and pages modes; separately record page additions/removals, global style changes, directory switches, and version resynchronization.
5. Preserve raw samples and outliers, stating repetition count. Historical single values and small samples are insufficient for stable p95 values or formal service metrics.

## Reproducible entry points and artifacts

See [Phase 3](phase3-single-view.md#m14-experiment-reproduction-and-reporting-conventions) for historical M14 commands. The following use new workspace experiment code. Paths/test names have been checked; this documentation task does not execute benchmarks or treat development scripts as release acceptance.

### Backend stage experiments

```sh
cargo test --release --locked --manifest-path src-tauri/Cargo.toml preview_pipeline_benchmark -- --ignored --nocapture --test-threads=1
```

The ignored test in `src-tauri/src/preview_benchmark.rs` generates synthetic 14/40/120-section fixtures, warms and samples different edit positions, and records compilation, SVG/page fingerprints, geometry, serialization, and response sizes. Current output is under `src-tauri/target/preview-benchmark/`:

- `sections-*.typ`: actual inputs generated in that run;
- `backend.json`: raw backend observations, not preset performance assertions;
- `browser-frames.json`: sequences of real compiled results for subsequent browser replay.

This is not an overall measurement of actual Tauri IPC/browser display; fixed loops in the function are not long-term performance promises. Preserve outputs and environment details rather than force regenerated page counts to match historical tables.

### Browser display experiments

```sh
pnpm exec vite build --config test-fixtures/preview-benchmark.vite.ts
node test-fixtures/run-preview-browser-benchmark.mjs
```

Generate backend frames first. The browser script requires a resolvable Playwright module and the local Edge installation used by the code. Playwright is not a pinned dependency in current package.json; without the environment, record “not run.” Use the script's PLAYWRIGHT_MODULE support to specify an existing installation; ordinary pnpm test does not include this pipeline.

The script replays locally in a separate browser without using the user's browser profile. It outputs `browser.json` and mode screenshots, recording JSON parsing, delta application, DOM commitment, paint opportunities, and page-node reuse. It does not exercise real invoke, so it cannot establish native IPC, IME, focus, or system-clipboard correctness. Screenshots and raw data together identify the test subject and result. Script/mode options may still change with parallel implementation; current source and artifacts govern execution.

## Discovered experimental observations and their boundaries

The 2026-10-23 review found backend/browser/Tinymist JSON already in the generated directory, timestamped 2026-10-22/23. To keep results outside the disposable target directory, [raw data and provenance](benchmarks/2026-10-22/README.md) were archived. This revision only read and archived them; it did not rerun them or invent missing machine/build metadata.

### Backend observations

Each size combines 27 samples across start/middle/end positions; the table gives medians in ms. Page export takes the median of each sample's fingerprint-plus-page-SVG duration. These are separate stages, not a combined latency including frontend work.

| Sections / actual pages | Compilation | Merged SVG | Page fingerprints+SVG | 3-range geometry query |
|---|---|---|---|---|
| 14 / 5 | 1.32 | 11.96 | 3.03 | 6.86 |
| 40 / 14 | 3.05 | 31.24 | 3.66 | 50.78 |
| 120 / 40 | 8.34 | 93.68 | 5.75 | 445.89 |

Median response-body sizes in the same groups were approximately 1.27/3.56/10.60MB for merged and 0.30/0.30/0.31MB for pages (decimal MB). Merged size records this experiment's serialized SVG object; page objects also include page manifests and other fields. Neither represents all overhead of its complete native protocol.

These observations support further investigation of SVG generation, response size, and geometry scanning. Small compile_ms values do not imply the entire edit takes a few milliseconds. These fixtures differ from the historical 14/34/100-page set; the tables cannot establish speedup between versions.

### Browser and Tinymist observations

The browser data reports version 155.0.4283.62, with 9 replays per project mode. Medians:

| Mode | JSON parse ms | DOM commit ms | Paint-opportunity proxy ms | Unchanged page 0 node retained |
|---|---|---|---|---|
| merged | 4.40 | 123.90 | 948.20 | 0/9 |
| paged | 0.40 | 8.90 | 474.40 | 9/9 |

Node retention supports page updates reducing DOM replacement, but rAF proxies still include waiting. Lower DOM-commit time does not establish that actual presentation cost disappears. Replay excludes native IPC, draft commitment, IME, and full editor focus handling.

Across 9 observations in the separate `tinymist.json`, median write-to-receive time is approximately 21.95ms, write-to-paint-opportunity 41.38ms, and delta-message size 3756 bytes. It starts at file writing, while this project's browser replay starts with handling already compiled results. Verifiable original-source hashes and Tinymist version/configuration are also missing. **Do not calculate how many times faster Tinymist is from these figures**; remeasure with identical documents, edits, and timing definitions.

This data improves the explanation of bottlenecks without closing the user report or establishing native acceptance of all later workspace changes. New results must fill the table below, not retain summary figures alone.

### Minimum record for subsequent result comparisons

| Revision/artifact | Mode, document, actual pages | Edit/repetitions | Backend and response size | Commitment/paint proxy/crop stability | Correctness result | Conclusion and limitations |
|---|---|---|---|---|---|---|
| Fill after execution | merged/pages; specify fonts/justify | Same action/position; preserve raw samples | List stages, not just totals | Distinguish actual presentation from proxies | Preserved styles/pagination/selection/error recovery? | Do not substitute expected benefits for measurements |

## Measurement and optimization order

New results and activation instructions for this round are at the end; see [Preview delta mechanism](preview-delta-protocol.md) for the stateful delta implementation. This phase evaluates only the in-project prototype and Tinymist/reflexo, without considering upstream modifications.

1. With identical documents, edits, fonts/justify settings, record input response, commitment, debounce, queue/lock wait, compilation, SVG generation, response bytes/IPC, DOM commitment, first paint, and neighbor stability in Release builds. Measure success, errors, and recovery separately.
2. Validate and refine the new scheduler and page-version protocol, covering stale results, document switches, directory changes, and error recovery; source, SVG, and geometry must match.
3. Reuse the final compiled document for rendering, geometry, and navigation. Prioritize eliminating new World creation/compilation in jump, and cache visible-range geometry by revision and directory.
4. Measure the new page-delta protocol, compare the integration cost of Tinymist/reflexo components, and handle viewport rendering separately. Preserve cross-page selection, shared glyph definitions, frozen error output, and focus clipping.
5. If focused drafts need previews during typing, implement background preview separately without breaking native input, undo, blur-time splitting, or temporary invalid-syntax handling.

Reducing debounce or disabling justification cannot replace overall optimization. Debug/Release is a measurement variable, not yet a confirmed cause of the user report. Tab consolidation can proceed alongside measurement without waiting for all long-term rendering changes.

## Scope of historical data

[Phase 3](phase3-single-view.md) preserves persistent-World and edit-position experiments; [Phase 4](phase4-product-validation.md) preserves 14/34/100-page backend-call durations, 3.2/7.9MB SVGs, and justify comparisons. They do not cover current commitment-to-display latency and are no longer used to claim the issue resolved.

The 2026-10-22 fix baseline recorded 344 frontend tests, followed by a 347-test snapshot containing page tests. These are historical snapshots. New test/build records for this round appear below. Native application/installer paths are in [README](../README.md#build-artifacts); the exe reflects its build snapshot and is not automatically updated by later dist/source changes.

## 2026-10-23: this round's page-level prototype and comparisons

The following benchmarks were actually executed. Machine: Windows x64 / i5-12600KF; Typst 0.15.1; standalone Edge 155.0.4283.62. Raw samples, environment, and medians are in [this round's JSON](benchmarks/2026-10-23-preview.json); do not mix them with earlier archive files.

### Backend and response bodies

Compile once in the same warmed World; both exporters use the same PagedDocument, alternating order to avoid comparing different compilation runs directly. Sample each size/position 9 times. The table lists only middle-position single-character replacements; actual page counts come from compilation:

| Actual pages | Compile ms | Merged SVG ms | Page fingerprint ms | Page export ms | Merged bytes | Page-level message bytes | 3-range geometry ms |
|---|---|---|---|---|---|---|---|
| 5 | 1.26 | 12.07 | 0.38 | 2.72 | 1,272,625 | 301,211 | 6.79 |
| 14 | 2.91 | 31.04 | 1.02 | 2.68 | 3,561,128 | 304,485 | 49.97 |
| 40 | 8.21 | 91.72 | 3.09 | 2.63 | 10,604,760 | 307,906 | 447.71 |

Each edit reexports 1 page. Complete position-specific samples and JSON-serialization durations are in the data file. Geometry queries run separately and are excluded from export time; they have become a more significant subsequent bottleneck. Page fingerprints still compare every page, so total cost is not strictly proportional only to changed-page count.

### Browser replay of the production frontend build

14-page fixture, the same 9 middle-position edits, 1000×900 CSS pixels, DPR 1. Replay includes JSON parsing, page-patch handling, and React/SVG; **it excludes Tauri IPC, 150ms debounce, and full Live cursor interaction**.

| Mode | JSON parse ms | Patch apply ms | DOM commit ms | Double-frame paint opportunity ms |
|---|---|---|---|---|
| merged, whole-master references | 4.20 | 0.00 | 118.00 | 791.90 |
| Page updates, still referencing the whole master | 0.30 | 0.70 | 8.90 | 473.70 |
| Page updates, referencing only pages near the viewport | 0.30 | 0.70 | 9.10 | 75.10 |

Both page modes retained unchanged page 0 nodes in 9/9 cases. Screenshots show consistent layout positions; merged and page-viewport modes differ by 35 pixels in the 1000×900 image, so pixel-perfect identity is not claimed. This covers only the current synthetic text fixture; complex images/gradients/transforms still need expanded visual acceptance checks.

The differences show that single-page caching and limited reference scope both matter. All page resource definitions remain in the hidden master; this round only limits display references, without claiming complete DOM/resource virtualization.

### Native-machine Tinymist/reflexo comparison

Uses Tinymist 0.15.10 from the local VS Code extension, with `preview --partial-rendering true --no-open`. Input is the same `sections-40.typ`, written in the same middle-position single-character edit sequence as the frames. The scroll container was actually positioned at the document middle. Medians across 9 samples:

- Initial full vector message: 66,784 bytes.
- Subsequent delta: 3,756 bytes; this project's page-level messages are approximately 304KB, still substantially coarser.
- File write to delta receipt: 21.83ms.
- File write to double-frame opportunity: 49.83ms.

The client was observed to contain both Canvas and SVG; these figures cannot be called purely SVG DOM-diff performance. Tinymist starts with file watching/compilation/transfer, while this project's browser replay starts with handling already compiled results; scaling and display paths also differ. **Do not divide these figures to calculate an end-to-end speedup.** Highly repetitive text favors resource deduplication and cannot replace a corpus containing images, tables, Chinese, and many distinct glyphs.

### Native Release: single-commit probe

In the latest Release WebView, load the same initial fixture, switch to real Live cursor, replace one character in the page 7 native textarea, then press Escape. Each mode completed 1 run. **These are exploratory single observations, not stable medians or an SLA.** WebView version: 155.0.4283.62. The test process disables background/occlusion throttling to avoid timer-policy changes when other windows cover it; the window uses the application's default size.

| Stage | merged ms | pages ms |
|---|---|---|
| Escape keydown to double-frame opportunity | 13,945.00 | 1,920.80 |
| Source effect to double-frame opportunity | 9,605.90 | 1,651.00 |
| Effect to actual debounce callback | 4,015.60 | 799.00 |
| invoke round trip | 2,308.60 | 357.20 |
| Recorded backend work within it | 72.57 | 8.23 |
| Result receipt to React layout commitment | 1,723.90 | 175.40 |

Response bodies are 3,561,628 / 304,672 bytes, with 14 / 1 exported pages. `transport_residual_ms` is approximately 2236.03 / 348.97ms, including other-command queueing, serialization, and WebView/JS scheduling; **it is not pure IPC time**.

Typst compilation in both `compile_typst` calls was an approximately 0.02ms cache hit. Other geometry commands may already have compiled the source, so this is not the edit's full compilation cost. Significant work also occurs between Escape and the source effect; hook-only timing misses it. An earlier merged sequence repeatedly entering/leaving focused blocks timed out waiting for the third input. Repeated native operations, scrolling, and neighbor stability therefore remain without full acceptance; these two successful points cannot close the issue.

Escape entered the composite view, so there is no neighbor-crop completion time for a continuously focused block; that field remains absent. Cache-version retention after page errors, recovery, and diagnostic clearing have been verified by real Rust compilation tests and frontend scheduling tests, without a separately reported native error-recovery latency.

These figures show the prototype reduces work in the native pipeline, but substantial editor main-thread/geometry/layout costs remain. They cannot establish a direct speed ratio against Tinymist's 49.83ms file-watching path.

### Activation, validation, and reproduction

Default remains merged. In the development WebView console, set `localStorage.setItem("typst.preview.mode", "pages")` and reload to enable the prototype; set it to `merged` and reload to restore the baseline. Browser development entry points also support `?preview=pages`. Enable timing separately with `typst.preview.metrics=1` and read `window.__typstPreviewSamples`. The switches are independent, record no document bodies, and retain at most 100 samples.

This round passed TypeScript, the production frontend build, and `pnpm tauri build --no-bundle`. The frontend first passed all 351 tests; 2 timing tests were then added, with 36 related regressions passing. Rust release passed all 100 tests, and the subsequently added page-error recovery test also passed. There is also 1 benchmark ignored by default; it was executed explicitly. Builds still report existing Node-version, chunk-size, and bundle-identifier notices.

Reproduction order:

```sh
cargo test --release --offline --manifest-path src-tauri/Cargo.toml preview_pipeline_benchmark -- --ignored --nocapture
pnpm exec vite build --config test-fixtures/preview-benchmark.vite.ts
node test-fixtures/run-preview-browser-benchmark.mjs
node test-fixtures/run-tinymist-benchmark.mjs
node test-fixtures/summarize-preview-benchmark.mjs
```

Specify Playwright through `PLAYWRIGHT_MODULE`. When `TINYMIST_BIN` points to an existing executable, the comparison script starts/stops a temporary service automatically; otherwise it uses an existing local service on 5187. Artifacts go to `src-tauri/target/preview-benchmark/`; the summary script archives timing samples without source into the documentation directory. The additional native Release script, `run-native-preview-benchmark.mjs`, uses a separate test process, unsaved document, and temporary local debugging port; it is not part of ordinary unit tests.

Current choice: retain the official page-level prototype for further validation, without immediately adding reflexo. It adds no rendering dependencies and has demonstrated reduced export, message, and DOM work. reflexo is substantially stronger in resource sharing, within-page reuse, and message size, but requires coordinated integration of frontend/backend protocols, resource lifetimes, and client rendering. Next address geometry/navigation reuse and correctness over a representative corpus, then decide whether within-page increments are needed.
