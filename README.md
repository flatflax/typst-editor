# Typst Editor

A desktop [Typst](https://typst.app/) editor built with Tauri + React + TypeScript.

This project targets writers who already know Typst syntax and want faster everyday
input, not a syntax-free editor. The direction it's working toward is **true WYSIWYG**
— editing without a gap between what's on screen and what the real Typst compiler would
actually produce (see [doc/interaction-design.md](doc/interaction-design.md) §4 for the
term and its use by comparable LaTeX editors).

Today it's a work in progress, with four views of the same document: a regular
rich-text WYSIWYG editor (ProseMirror + CSS) kept in sync with a separate live preview
pane; raw Typst and Markdown source views; and **Live cursor**, built around
**focus-reveals-source** — every paragraph renders normally except the one currently
focused, which becomes its own native, editable source-text region (free undo/redo,
IME, copy/paste), with no separate preview pane at all. Live cursor is the current step
toward closing the WYSIWYG gap; the other three views are expected to eventually be
absorbed into it, but it isn't the default view yet. See [plan.md](plan.md) and
[doc/interaction-design.md](doc/interaction-design.md) for the roadmap and what's still
open before that happens.

## Features

- **WYSIWYG, Typst source, Markdown, and Live cursor views** of the same document —
  switch freely, content and formatting survive the round trip.
- **Live cursor** (see above): cross-block undo/redo, Ctrl/Cmd+B/I, Up/Down navigation
  across a block boundary, and reference-chain navigation (jump to where a
  variable/label was declared) — all work across the whole document, not just within
  one focused block. A persistent toolbar covers headings/lists/tables/marks.
- **Rich content**: headings, lists, tables, images/figures, and links, all directly
  editable in the WYSIWYG view (and, via its own toolbar, in Live cursor).
- **Live preview** rendered by the real `typst::compile`, not a reimplementation —
  recompiled as you type.
- **Click-to-source / cursor-to-preview sync** — click the preview to jump the editor
  cursor there, and vice versa.
- **Inline diagnostics** — compiler errors and warnings surface next to the preview
  instead of crashing the app.
- **Floating toolbar and `/` slash-command menu** for formatting and inserting blocks
  in the WYSIWYG view (Live cursor has its own toolbar instead, no slash menu yet).
- **Open / Save / Save As** (native File menu), a recent-files list, an
  unsaved-changes guard, and autosave (once a file has been saved at least once,
  further edits are written to it automatically a couple of seconds after you pause —
  manual save always still works).
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
