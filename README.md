# Typst Editor

A desktop [Typst](https://typst.app/) editor built with Tauri + React + TypeScript. Edit Typst
source in a CodeMirror-based editor and see a live SVG preview rendered by the real Typst
compiler, with two-way sync between source and preview.

## Features

- **Live preview** — Typst source is recompiled (debounced) via `typst::compile` and rendered to
  SVG as you type.
- **Click-to-source** — click anywhere in the preview to move the editor cursor to the
  corresponding point in the source.
- **Cursor-to-preview sync** — moving the cursor in the source highlights the matching position in
  the rendered preview.
- **Diagnostics** — compiler errors and warnings are surfaced next to the preview instead of
  crashing the app.
- Embedded fonts, including CJK support.

## Project structure

- [src/](src/) — React/TypeScript frontend (CodeMirror editor, preview pane, click/cursor sync).
- [src-tauri/src/](src-tauri/src/) — Rust backend:
  - [typst_world.rs](src-tauri/src/typst_world.rs) — `typst::World` implementation backing the
    in-memory document (embedded fonts, no filesystem access).
  - [compile.rs](src-tauri/src/compile.rs) — `compile_typst` command: source → SVG + diagnostics.
  - [jump.rs](src-tauri/src/jump.rs) — `jump_from_click` / `jump_from_cursor` commands, built on
    `typst-ide`, for bidirectional source/preview position mapping.

## Development

Requires [pnpm](https://pnpm.io/) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/)
for your platform (Rust toolchain, WebView2 on Windows).

```sh
pnpm install
pnpm tauri dev
```

Other useful scripts:

```sh
pnpm dev        # Vite dev server only (frontend)
pnpm build      # Type-check and build the frontend
pnpm tauri build # Build the desktop app
```

Rust-side tests (compile + jump sync) live alongside their modules and run with:

```sh
cargo test --manifest-path src-tauri/Cargo.toml
```

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
