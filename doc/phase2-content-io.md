# Phase 2: content and file operations (M7–M12)

Status: feature milestones complete; gaps remain in historical M12 interaction acceptance records. Review date: 2026-10-23. This document distinguishes code delivery, automated tests, and native acceptance, without attributing later Live cursor results to this phase.

## Original goals, order, and invariants

The MVP established the conversion loop; this phase makes it usable with real files and gradually expands content. The order is file operations→PDF→links→tables→images→editing interaction: images depend on the document directory, and interaction depends on existing structural commands. Improve usability of the existing subset before taking on complex semantics.

Retain the same schema, bidirectional Typst/Markdown conversion, raw-source preservation, and recursive editing operations. Each addition needs an explicit supported shape and fallback rules; “does not crash” is not full support.

## Original goals compared with results

| Milestone | Original goal and acceptance criteria | Actual results and evidence | Deviations and boundaries |
|---|---|---|---|
| M7 Files | Extension selects format; open/save/save as and recent files work; undo to saved content restores clean state | dialog/fs/store, file-helper tests, and native menu accelerators | Native dialogs and file errors need manual checks; autosave came later |
| M8 PDF | Use current document and the same engine; generate a PDF successfully and write no file on error | export_pdf; Rust tests check PDF headers and error paths | Not full-text extraction or page-by-page visual comparison; Live draft export coverage was added later |
| M9 Links | Links in both formats, stable composition with other marks, and editing through toolbar/Mod-k | Recursive link AST, PM link mark, Markdown conversion, and combined-mark tests | Marked-range position precision retains M5 limitations |
| M10 Tables | Parse restricted Typst tables, recursive cells, row/column operations, and Markdown round trips | prosemirror-tables; integer/array column definitions, raw-call fallback, and conversion tests | No arbitrary styling, row/column spans, or table.cell; GFM loses layout properties such as column widths |
| M11 Images/figure | Relative paths, real image previews, plain-text captions, and consistent export | image/figure mapping, backend data URLs, and image present/missing/out-of-root tests | Replaced planned static asset protocol with restricted backend reads; caption→alt conversion loses semantics |
| M12 Interaction | Floating toolbar, slash menu, block operations, file menu, and continued input at document end | PM plugins, block-level hover +, trailing-paragraph plugin, and required style fixes | Actual drag reordering is unimplemented; historical records cover pure logic, type/build checks, and startup only, so toolbar placement/menus/hover cannot be described as fully passing native acceptance |

## Feature contracts and tradeoffs

### Files and PDF

`.typ` and `.md` select the corresponding conversion entry point. Dirty state compares current content with the saved snapshot rather than counting edits; save completion, undo to original text, and save-as paths need separate checks. The file menu owns Ctrl/Cmd+O, S, and Shift+S; duplicate DOM handlers were removed to avoid a shortcut firing twice.

PDF compiles and writes through the same Typst engine. M8 aimed for correct file generation, not automated visual comparison of every page. Inclusion of unblurred Live drafts in export is additional Phase 4 coverage, not evidence of tests at M8.

### Links and tables

Link bodies convert recursively, combining existing bold/italic and other marks through `addToSet`; Typst text escapes `[`/`]`.

Restricted tables accept a `columns:` argument and flat content-block cells, reusing body conversion inside cells. After a column-count change, a mismatched old `columnsRaw` becomes an integer column count rather than retaining an incorrect column definition. Complex arguments, non-content-block cells, or unrepresentable shapes must preserve the entire raw call, not only recognizable cells.

### Images and paths

The model stores relative paths, not image bytes. The opened document's directory is passed through base_dir to compilation, export, and image reads. Because documents have no fixed project root, `read_image_as_data_url` replaced the planned static asset protocol, reusing VirtualPath root restrictions and returning data URLs.

The old WYSIWYG image NodeView reads the current documentDirRef and must not retain the old directory after a file switch. Missing images need explanatory diagnostics; paths escaping the document root must be rejected rather than broadening arbitrary file access to display images.

### Cross-format losses must be explicit

| Content | Typst / model representation | Markdown representation and loss | Acceptance judgment |
|---|---|---|---|
| Table column widths | Can preserve `columns: (1fr, 2fr)` | GFM has no column widths; returning to Typst may produce equal-width columns | Preserved content does not mean equivalent layout; exclude from lossless cross-format fixtures |
| Cells with block content | Recursive representation | GFM cells support inline content only; preserve with fences | Check preservation fallback rather than forcing ordinary GFM tables |
| Image captions | Plain-text figure caption | Text passes through image alt, losing the distinction between caption and alternative-text semantics | Text can round-trip stably, but semantic conversion is not lossless |
| Unsupported complex calls | Raw-source nodes | Typed fences | Check that original text is neither deleted nor rewritten; do not claim structured support |

`src/loop.test.ts` explicitly excludes `tableWithArrayColumns` from lossless model assertions. New format mappings must update the loss inventory and fixtures, rather than weaken the meaning of “round-trip equivalence.”

### Specific M12 interaction boundaries

- The floating toolbar appears for text selections and provides bold, italic, code, and links.
- The slash menu triggers only when an entire paragraph is a single `/`, not within ordinary sentences or paths.
- Hover `+` is a single **block-level** tracked button positioned through posAtCoords/coordsAtPos; it is not a table drag handle, and row/column drag reordering is absent.
- When a closed block ends the document, ensureTrailingParagraphPlugin adds an empty paragraph for continued input; it adds no serialized content.
- Existing ProseMirror plugins are used without Tiptap or Plate; their structures/dependencies are not necessary to adapt the existing schema.
- Required ProseMirror and table styles are part of cursor/selection correctness, not merely decoration.

## Validation entry points and native checks

These commands provide reproducible review entry points; code tests are not rerun for this documentation revision:

```sh
pnpm test src/shell/fileIO.test.ts src/spokes/typstAst.test.ts src/spokes/markdown.test.ts src/editor/wysiwygCommands.test.ts src/loop.test.ts
cargo test --locked --manifest-path src-tauri/Cargo.toml ast::tests
cargo test --locked --manifest-path src-tauri/Cargo.toml export::tests
cargo test --locked --manifest-path src-tauri/Cargo.toml image_
```

| Scenario | Actions and expected result | How to record validation status |
|---|---|---|
| File cycle | Open .typ/.md, edit, save, reopen; change paths with save as; undo to snapshot restores clean state | Native checks identify file, platform, and result; pure helper tests do not replace them |
| Export errors | Valid source produces PDF; invalid calls return errors without leaving invalid artifacts | Corresponding Rust export tests; record visual comparisons separately |
| Links and tables | Combined-mark round trips, row/column insertion/deletion, and full raw-source preservation for unsupported tables | Separate automated conversion/command tests from native button checks |
| Relative images | Same-named images in different directories, missing files, and out-of-root paths | Rust file tests do not establish correct NodeView display after directory switches |
| M12 interaction | Toolbar near selection; no slash trigger mid-sentence; hover + follows the correct block; input works after a trailing table | **Historical native acceptance gaps remain open**; a launchable application does not imply a pass |
| Actual drag reordering | Move blocks or rows/columns while retaining correct undo/structure | Unimplemented; not an acceptance item for existing features |

## Phase handoff and risks

M12 feature-code completion and sufficient interaction acceptance are separate matters. Phase 4 adapted its own toolbar but did not thereby fill every acceptance-evidence gap for hover/menus in the old PM editing surface.

Equations, citations, footnotes, multi-file World support, and full `#let`/`#show` semantics remain open; later definition navigation does not mean all these semantics are supported. Range geometry and incremental compilation advanced in Phase 3/4 and must not still be described as entirely undone. Collaboration is explicitly out of scope, not a missing defect.

The main risks remain real-world tables frequently falling back to raw preservation, cross-format semantic/layout loss, and image-file access boundaries. Further expansion should follow real fixtures and user scenarios, not broadening generic claims of “table/image support.”
