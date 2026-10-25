# Typst Editor

A desktop Typst editor built with Tauri v2, React, and TypeScript. Intended for writers who already know Typst; the project is still under development.

## Current features

- Four views: ProseMirror rich-text editing, Typst source, Markdown source, and Live cursor. The first three have a separate preview; Live cursor displays compiled output in the editing surface and replaces the focused block with a native source textarea.
- Headings, lists, links, tables, and images/captions; Live cursor provides a structural toolbar, cross-block selection, undo/redo, clipboard operations, vertical navigation, and navigation from usages to variable/label definitions.
- Native file menus, recent files, open/save/save as, autosave, unsaved-change protection, and PDF export. Unblurred Live cursor drafts are included in saves and exports.
- Native Typst compilation, SVG previews, diagnostics, click navigation, and cursor mapping. Source views recompile as text is entered; focused Live cursor drafts recompile after commitment.
- Compilation failures retain the last successful rendering and show diagnostics and the failing block's source.

The old WYSIWYG view remains the default, and the four tabs have not been merged. Recent draft, clipboard, layout, and exit fixes have passed frontend regression tests; acceptance checks in the updated native application remain pending. See [plan.md](plan.md) for progress.

## Data and limitations

Typst, Markdown, and the ProseMirror model are connected by parsing and serialization. Active source views and Live cursor drafts maintain their own text buffers; the model is not the sole state at every moment. Conversion tests cover the supported structural subset; they do not guarantee byte-for-byte preservation of arbitrary Typst after switching views.

Unsupported structures are preserved in raw-source nodes and represented by typed code fences in Markdown. Live cursor can edit raw source directly. Converting structured image captions to Markdown alternative text loses caption semantics; arbitrary merged table cells, styling, and multi-file projects are not yet supported.

Fonts come from embedded fonts and the host system. CJK coverage depends on system fonts; a complete CJK font library is not bundled. Long-document updates still generate and replace the entire SVG; performance remains an open issue. See [performance analysis](doc/preview-performance.md).

## Development environment

- Node.js 20.19+ or 22.12+, and pnpm 10.11.0 (pinned in `package.json`).
- Current stable Rust; Rust/Cargo 1.82 does not support the Rust 2024 edition required by locked dependencies.
- Windows: WebView2, Visual Studio C++ Build Tools, and Windows SDK. For other platforms, follow the [Tauri prerequisites](https://tauri.app/start/prerequisites/).
- If a standalone Cargo check on Windows cannot find the MSVC linker, run it in a Developer PowerShell/Command Prompt with the appropriate build environment loaded. Do not record an environment failure as a passing test or a product regression.
- Typst-related Rust crates are pinned to 0.15.1; install dependencies using the lockfiles.

```sh
pnpm install --frozen-lockfile
pnpm tauri dev
```

```sh
pnpm dev          # Frontend development server only, port 5183
pnpm test         # Frontend tests
pnpm build        # TypeScript checks and frontend production build
cargo test --locked --manifest-path src-tauri/Cargo.toml
pnpm tauri build --no-bundle  # Release desktop application
pnpm tauri build            # Desktop application and installers
```

An ordinary browser has no Tauri backend. The layout fixture at `/test-fixtures/live-cursor-rendering.html` uses mocked SVG/IPC to check clipping, short drafts, and width changes; it cannot replace real compilation, clipboard, or native exit acceptance checks. See [test fixtures](test-fixtures/README.md).

## Build artifacts

| Command | Default Windows output |
|---|---|
| `pnpm build` | `dist/`: frontend assets |
| `cargo check` | Type-checking metadata and caches; no runnable application |
| `pnpm tauri build --no-bundle` | `src-tauri/target/release/typst-editor.exe` |
| `pnpm tauri build` | The exe above, plus installers under `src-tauri/target/release/bundle/msi/` and `bundle/nsis/` |

A Release exe containing the clipping, textarea, and exit-permission fixes was built in this round, and checked with a real short document and a clean close. It corresponds to the 2026-10-22 23:51 build snapshot; subsequent parallel preview changes are not all included, and the MSI/NSIS packages are still old. Run a full desktop build again before distribution; changing the target directory or build configuration changes these paths.

[Project plan](plan.md) · [Architecture](doc/architecture.md) · [Interaction specification and scenarios](doc/interaction-design.md#6-核心交互机制聚焦块编辑源码) · [Phase goals and acceptance records](doc/phase4-product-validation.md)

Development tools: [pnpm](https://pnpm.io/), [VS Code](https://code.visualstudio.com/), [Tauri extension](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode), and [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer).
