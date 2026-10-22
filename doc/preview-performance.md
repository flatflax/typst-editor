# Live cursor preview latency — reopened 2026-10-22

## User report and scope

The user reports slow **preview updates after editing in Live cursor**, compared
with Tinymist. Track this as commit-to-visible latency, separately from application
startup, opening a file, and typing responsiveness. Earlier measurements of the
compiler alone do not close this issue.

## Verified implementation differences

| Stage | This editor | Tinymist preview |
|---|---|---|
| Trigger | Focused drafts stay native; compilation starts after block commit, then a 150ms debounce | Configurable refresh; default `onType` |
| Typst compilation | Persistent `TauriWorld`, incremental `Source::edit`, `comemo` reuse already implemented | Persistent compiler actor and compiler state |
| Render output | Every successful update calls `typst_svg::svg_merged` for the entire document | Persistent `IncrSvgDocServer`; normal updates call `pack_delta` |
| Transport/update | Whole merged SVG string over Tauri IPC; replace master SVG content | Incremental preview data; render actor coalesces queued updates |
| Visible work | Full master SVG plus crop references; all pages remain in that master | Partial rendering can restrict visible work; documented default is enabled |
| Interaction geometry | Separate `block_geometry` IPC requests; each batch traverses the document's frame tree | Compiled document/renderer state is reused for source/render queries |

Sources:

- Tinymist [`RenderActor`, queue draining and delta rendering](https://github.com/Myriad-Dreamin/tinymist/blob/31c3057ec2a9aed81f08256166d1ec2de2e0189a/crates/typst-preview/src/actor/render.rs#L99).
- Tinymist [refresh and partial-rendering configuration](https://myriad-dreamin.github.io/tinymist/config/neovim.html).
- Tinymist [compiler/render actor responsibilities](https://myriad-dreamin.github.io/tinymist/principles.html).
- Local `src-tauri/src/compile.rs`, `src/editor/TypstLiveView.tsx`, `src/App.tsx`.

The important distinction is incremental **compilation** versus incremental
**rendering and presentation**. This project has the former but currently still
rebuilds/transfers/replaces the entire SVG after a successful compile. SVG itself
does not prevent incremental rendering; Tinymist's SVG pipeline demonstrates it.

## First reductions implemented

1. Live cursor no longer simultaneously mounts the ordinary right-hand preview.
   There is one compiled SVG master, and the editor occupies the full workspace.
2. An inactive Live cursor tab no longer mounts that master or requests combined-view
   cursor/selection geometry. Its editor/history state remains mounted.
3. A focused native block no longer requests self-drawn-caret geometry that it
   cannot display. Required block crops/reference navigation remain available.
4. Extracting the multi-megabyte SVG body is memoized per render result; focus,
   caret, and geometry state updates no longer repeatedly scan it.

Regression tests assert one master copy, absence of duplicate preview, no inactive
geometry calls, SVG-body extraction reuse, and no combined-caret query after a
commit that stays in native editing mode. These establish reductions in work, not
a measured millisecond improvement on a real document.

Validation: 339 frontend tests pass, along with TypeScript checking and the Vite
production build. The build retains the existing Node-version and chunk-size
warnings. No Rust implementation changed in this first reduction.

## Remaining work, in order

1. Measure the same document and edit in an optimized build. Split timings into
   debounce, queue/lock wait, Typst compile, SVG generation, response bytes/IPC,
   DOM update, first paint, and neighbor crop settlement. Capture compiler success
   and error recovery separately. The prior 14/34/100-page numbers in Phase 4 are
   historical backend-only measurements, not current end-to-end measurements.
2. Add render revisions and a latest-request scheduler. Render updates should use
   matching source/geometry, ignore superseded results, and coalesce queued edits.
3. Reuse one compiled document for rendering, geometry, and navigation. In
   particular, `jump.rs` still constructs a fresh World and compiles for each query;
   viewport block-geometry requests also repeatedly walk all glyphs. Batch visible
   ranges and cache geometry by document revision/directory.
4. Replace whole-document SVG presentation with page/scene updates and viewport
   rendering. Preserve cross-page selections, global glyph definitions, frozen
   error rendering, and focused-block crops. Benchmark a small native page-diff
   protocol against adopting Tinymist/reflexo components before selecting one.
   A clipped `<use>` of the whole master reduces duplicated authored markup, but
   does not establish that the browser avoids offscreen scene work; profile its
   rendering cost rather than treating cropping as page virtualization.
5. Evaluate background preview of an active draft only if on-type refresh is
   desired. It must not stall native input, reset native undo, or break lazy block
   splitting while a draft contains new paragraphs or temporarily-invalid syntax.

Do not treat reducing debounce or changing page layout/justification as a substitute
for measuring and reducing the full update pipeline. Development/debug versus
release mode is a measurement variable, not a confirmed explanation of this report.

## Build outputs

`pnpm build` produces frontend assets in `dist/`; `cargo check` produces metadata
and compilation caches, not a runnable desktop application. At investigation time
there is no app executable or installer in this checkout.

`pnpm tauri build --no-bundle` produces the optimized standalone app at
`src-tauri/target/release/typst-editor.exe` on this Windows target. `pnpm tauri build`
also creates installers under `src-tauri/target/release/bundle/` (NSIS/MSI according
to the bundle configuration). Those desktop artifacts have not been built as part
of this investigation.
