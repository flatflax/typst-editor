# Typst Editor

A desktop [Typst](https://typst.app/) editor built with Tauri + React + TypeScript.

This project aims to make Typst editing feel direct: one visual surface, no source code in sight by default, while every character on the page is still backed by the real Typst compiler rather than an approximation. Today, the editor is partway there: a rich-text WYSIWYG view, a raw Typst source view, and a raw Markdown view all edit the same underlying document and stay in sync, alongside a live preview rendered by the real compiler. The end state is to collapse these into a single seamless editing surface, where source and rendered document are no longer separate modes of working. see [plan.md](plan.md) for the detailed roadmap.

## Features

- **WYSIWYG, Typst source, and Markdown views** of the same document — switch freely,
  content and formatting survive the round trip.
- **Live preview** rendered by the real `typst::compile`, not a reimplementation —
  recompiled as you type.
- **Click-to-source / cursor-to-preview sync** — click the preview to jump the editor
  cursor there, and vice versa.
- **Inline diagnostics** — compiler errors and warnings surface next to the preview
  instead of crashing the app.
- **Open / Save / Save As**, a recent-files list, and an unsaved-changes guard.
- **Export to PDF.**
- Embedded fonts, including CJK support.

## Usage

- `pnpm tauri dev` to launch (see [Development](#development)) — packaged releases
  are not published yet.
- Opens and saves `.typ` and `.md` files directly; **Export PDF** renders the current
  document to a PDF alongside the source.

## How it works

Hub-and-spoke: the **Editor Model** (a ProseMirror document) is canonical. Typst
source and Markdown source are two independent spokes that losslessly parse into and
serialize out of it — every view derives from the model, not from each other, and the
preview always compiles the model's current Typst serialization through the real
compiler.

The Rust backend (`src-tauri/src/`) owns everything needing the real Typst engine:
parsing (`typst_syntax::parse`, `ast.rs`), compiling and rendering
(`typst::compile` + `typst-svg`/`typst-pdf`, `compile.rs`/`export.rs`), and
click/cursor position mapping (`typst-ide`, `jump.rs`) — all backed by a hand-written
`TauriWorld` (`typst_world.rs`) that merges embedded fonts with the host's system
fonts for CJK glyph fallback. The TypeScript frontend (`src/`) owns the ProseMirror
schema and both source-format conversions (`typstAst.ts`, `markdown.ts` via `remark`),
since neither needs to cross the IPC boundary per keystroke.

Syntax outside the supported subset — `#let`/`#show`, an unhandled `#table` shape,
anything else unrecognized — round-trips verbatim as an opaque, non-editable node
rather than being dropped or crashing the parse; on the Markdown spoke, which has no
equivalent, it round-trips through a tagged fenced code block instead. Full
architecture and the milestone roadmap live in [plan.md](plan.md).

## Development

Requires [pnpm](https://pnpm.io/) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/)
for your platform (Rust toolchain, WebView2 on Windows).

```sh
pnpm install
pnpm tauri dev
```

Other useful scripts:

```sh
pnpm dev         # Vite dev server only (frontend)
pnpm build       # Type-check and build the frontend
pnpm tauri build # Build the desktop app
pnpm test        # Frontend tests (vitest)
cargo test --manifest-path src-tauri/Cargo.toml  # Rust tests
```

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
