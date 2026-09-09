# Typst Editor

A desktop [Typst](https://typst.app/) editor built with Tauri + React + TypeScript.

This project targets writers who already know Typst syntax and want faster everyday
input, not a syntax-free editor. The direction it's working toward is **zero render
drift** — editing without a gap between what's on screen and what the real Typst
compiler would actually produce. Today it's a work in progress: the WYSIWYG view is a
regular rich-text editor (ProseMirror + CSS) kept in sync with a separate live preview
pane rendered by the real compiler, alongside raw Typst/Markdown source views and an
experimental "Live cursor" view (a real caret/selection drawn directly on the
live-compiled document, no separate preview pane — see Features below) that's the
current step toward closing that gap. The target end state, per the
**focus-reveals-source** design, collapses these into one surface where every block
renders normally except the one currently focused, which shows its native editable
source — see [plan.md](plan.md) and [doc/interaction-design.md](doc/interaction-design.md)
for the detailed roadmap and rationale.

## Features

- **WYSIWYG, Typst source, Markdown, and Live cursor views** of the same document —
  switch freely, content and formatting survive the round trip. Live cursor is
  experimental: a self-drawn caret/selection with click-to-position, drag-to-select,
  and typing (including CJK IME) directly on the live-compiled render.
- **Rich content**: headings, lists, tables, images/figures, and links, all directly
  editable in the WYSIWYG view.
- **Live preview** rendered by the real `typst::compile`, not a reimplementation —
  recompiled as you type.
- **Click-to-source / cursor-to-preview sync** — click the preview to jump the editor
  cursor there, and vice versa.
- **Inline diagnostics** — compiler errors and warnings surface next to the preview
  instead of crashing the app.
- **Floating toolbar and `/` slash-command menu** for formatting and inserting blocks.
- **Open / Save / Save As** (native File menu), a recent-files list, and an
  unsaved-changes guard.
- **Export to PDF.**
- Embedded fonts, including CJK support.

## Usage

- `pnpm tauri dev` to launch (see [Development](#development)) — packaged releases
  are not published yet.
- Opens and saves `.typ` and `.md` files directly; **Export PDF** renders the current
  document to a PDF alongside the source.

## How it works

Hub-and-spoke: the **Editor Model** (a ProseMirror document) is canonical. Typst and
Markdown are independent spokes that parse into and serialize from the Editor Model,
preserving unsupported Typst constructs explicitly rather than silently dropping them.
Every view derives from the model, not from each other, and the preview always compiles
the model's current Typst serialization through the real compiler.

The Rust backend (`src-tauri/src/`) owns everything needing the real Typst engine:
parsing (`typst_syntax::parse`, `ast.rs`), compiling and rendering
(`typst::compile` + `typst-svg`/`typst-pdf`, `compile.rs`/`export.rs`), resolving
image paths for the WYSIWYG preview (`asset.rs`), and click/cursor position mapping
(`typst-ide`, `jump.rs`) — all backed by a hand-written `TauriWorld` (`typst_world.rs`)
that merges embedded fonts with the host's system fonts for CJK glyph fallback. The
TypeScript frontend (`src/`) owns the ProseMirror schema and both source-format
conversions (`typstAst.ts`, `markdown.ts` via `remark`), since neither needs to cross
the IPC boundary per keystroke.

Syntax outside the supported subset — `#let`/`#show`, an unhandled `#table` shape,
anything else unrecognized — round-trips verbatim as an opaque, non-editable node
rather than being dropped or crashing the parse; on the Markdown spoke, which has no
equivalent, it round-trips through a tagged fenced code block instead. See
[plan.md](plan.md) for the roadmap and [doc/](doc/) for full architecture and
phase-by-phase detail.

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
