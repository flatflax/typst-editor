# Test fixtures

Manual real-machine testing documents — not part of the automated test suite (open them
via the app's own File > Open), kept here specifically so they don't get lost between
sessions the way the original did.

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
