# Test fixtures

Preview performance probes and generated artifact paths are documented in
[`doc/preview-performance.md`](../doc/preview-performance.md#2026-10-23-this-rounds-page-level-prototype-and-comparisons).
The browser/native scripts require an existing Playwright installation (optionally
set `PLAYWRIGHT_MODULE`); they are separate from `pnpm test`. Generated source,
SVG frames and screenshots stay in `src-tauri/target/preview-benchmark/`.

Manual test fixtures, separate from the automated suite. Open `.typ` documents
through the app's File > Open; the browser fixture below runs through Vite.

## `live-cursor-rendering.html`

Run `pnpm dev`, then open
`http://localhost:5183/test-fixtures/live-cursor-rendering.html`. The page mounts
the real App with simulated SVG, geometry and Tauri IPC. It does not read or write
files and does not exercise the real Typst compiler or native close permissions.

Switch to Live cursor and click the page to focus a block. Check that adjacent
labels appear once, the SVG crops have matching viewport/viewBox ratios, and a
short draft has no internal scrollbar. Use Narrow/Wide while focused to check
that width and height update without losing the draft or native focus. This
fixture reproduces the conditions behind the mixed px/pt crop and border-box
textarea regressions; native multi-page and IME acceptance remains separate.

## `m21-multipage-test.typ`

A 20-section, genuinely multi-page document (20 headings, each with two filler
paragraphs and a bullet list) — recreated from
[`multi_page_fixture`](../src-tauri/src/compile.rs) (the same generator M14 already uses
for recompile-latency measurement in Rust tests), since the original file referenced by
that name in `doc/phase3-single-view.md` (M21/M22 manual testing) was never committed to
the repo and had been lost. Use this for testing anything that specifically needs
multiple pages — e.g. Phase 4's focus-reveals-source split mode, which has since been
real-machine tested against this exact fixture across several rounds (see
`doc/phase4-product-validation.md` for the bugs that testing found and fixed — placeholder-
height estimation, focus-entry/switch performance, scroll-position restore, among others).

## `perf-huge-300-sections.typ`

A 300-section, ~100-page, ~279KB document — same `multi_page_fixture`-style generator as
above, scaled up. Built for the long-document compile-latency Spike
(`doc/interaction-design.md` §10 结论 23, `doc/phase4-product-validation.md`): the backend
`cargo test --release` benchmark measured ~489ms for a single-character-edit recompile at
this size. Focus a paragraph, change one character and blur to inspect the full
update path. The historical backend number excludes frontend presentation and
must not be treated as the document's current end-to-end update latency.
