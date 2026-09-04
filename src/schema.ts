// Editor Model schema (plan.md M2/M3): the ProseMirror doc schema that sits
// at the hub of Typst source <-> Editor Model <-> Markdown source. Scope is
// deliberately the MVP syntax subset shared by both source grammars —
// headings (1-3), paragraphs, bullet/ordered lists, the strong/em/code
// marks, hard line breaks — plus the opaque `unsupported_block`/`typst_call`
// escape hatches and `#set` rule support (see plan.md "Unsupported input
// policy" and the `typst_call`/`#set` architecture sections). No UI wiring
// here yet (M5); this is schema + node/mark specs only.
import { Schema, type Node as PMNode } from "prosemirror-model";
import { tableNodes } from "prosemirror-tables";

// Alias for the in-memory Editor Model value passed between the Typst/
// Markdown <-> model converters (M3/M4) — a plain `prosemirror-model` Node
// rooted at this schema's `doc`.
export type PMDoc = PMNode;

// One `#set func(...)` rule, carried verbatim (plan.md "`#set` rule
// support"). Lives on `doc.attrs.settings`, not interleaved in flow content.
export type TypstSet = { function: string; raw: string };

// prosemirror-tables' `table`/`table_row`/`table_cell`/`table_header` node
// specs (plan.md M10). `cellContent: "block+"` matches Typst's own table
// cells, which can hold full markup (headings, lists, marks — not just
// plain text). No custom `cellAttributes` (colspan/rowspan/per-cell styling
// are out of the MVP subset — see ast.rs's `as_table_call`).
const tableNodeSpecs = tableNodes({ tableGroup: "block", cellContent: "block+", cellAttributes: {} });

export const schema = new Schema({
  nodes: {
    doc: {
      content: "block+",
      // Top-level `#set` rules (plan.md "`#set` rule support"): kept out of
      // the flow content since they configure rendering rather than
      // producing content at their own position.
      attrs: { settings: { default: [] as TypstSet[] } },
    },

    paragraph: {
      group: "block",
      content: "inline*",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    },

    // Typst `= `/`== `/`=== ` and Markdown `#`/`##`/`###` both stop at level
    // 3 in the MVP subset (plan.md line 31), so `level` is constrained here
    // rather than left open-ended.
    heading: {
      group: "block",
      content: "inline*",
      attrs: { level: { default: 1 } },
      parseDOM: [1, 2, 3].map((level) => ({ tag: `h${level}`, attrs: { level } })),
      toDOM: (node) => [`h${node.attrs.level}`, 0],
    },

    bullet_list: {
      group: "block",
      content: "list_item+",
      parseDOM: [{ tag: "ul" }],
      toDOM: () => ["ul", 0],
    },

    // `order` is the starting number (Markdown's `start` attribute /
    // Typst's `#enum(start: ...)`), defaulting to 1 for the common case.
    ordered_list: {
      group: "block",
      content: "list_item+",
      attrs: { order: { default: 1 } },
      parseDOM: [
        {
          tag: "ol",
          getAttrs: (dom) => ({
            order: (dom as HTMLElement).hasAttribute("start")
              ? Number((dom as HTMLElement).getAttribute("start"))
              : 1,
          }),
        },
      ],
      toDOM: (node) =>
        node.attrs.order === 1 ? ["ol", 0] : ["ol", { start: node.attrs.order }, 0],
    },

    // A list item's primary content plus, optionally, one level of nested
    // sub-lists — both Typst and Markdown allow nesting a bullet/ordered
    // list under a list item (see the nested-list fixture in
    // schema.fixtures.ts), so the schema needs to represent it even though
    // the MVP has no UI for authoring it yet. The primary content is usually
    // a paragraph, but a list item can also be a standalone `#name(...)`
    // call or fall outside the MVP subset entirely (plan.md M3's
    // `parse_typst_ast` degrades either case rather than failing the whole
    // list) — `heading` is included for schema symmetry with `doc` even
    // though Typst's grammar never actually nests one inside a list item.
    //
    // `paragraph` MUST be the first alternative: ProseMirror resolves a
    // content expression's *default* block type (used whenever it needs to
    // create fresh empty content — e.g. prosemirror-schema-list's
    // splitListItem on Enter) to whichever alternative comes first. With
    // `heading` listed first, every new item created by pressing Enter in a
    // WYSIWYG list silently became a heading instead of a paragraph —
    // confirmed live and matching a user report of list items scattering
    // into separate single-item lists (each new "heading" item apparently
    // couldn't continue as a list item the way a paragraph does, so the
    // toolbar got re-clicked per line, each click wrapping a lone paragraph
    // in its own new list — hence blank lines between items and each
    // showing "1." independently, its own list's own default order).
    list_item: {
      content: "(paragraph | heading | typst_call | table | image | unsupported_block) (bullet_list | ordered_list)*",
      parseDOM: [{ tag: "li" }],
      toDOM: () => ["li", 0],
    },

    // Opaque, non-editable escape hatch (plan.md "Unsupported input
    // policy"): carries the verbatim source text of a region outside the
    // MVP subset so the round trip stays lossless without understanding it.
    // `atom` + `isolating` keep ProseMirror from ever trying to parse or
    // merge content into it.
    unsupported_block: {
      group: "block",
      attrs: { raw: { default: "" } },
      atom: true,
      isolating: true,
      selectable: true,
      toDOM: (node) => [
        "pre",
        { "data-unsupported-block": "true", contenteditable: "false" },
        node.attrs.raw,
      ],
    },

    // A forced line break (Typst `\`, Markdown trailing double-space / `<br>`)
    // — part of the MVP subset (plan.md line 31) but easy to miss since it
    // has no PM-schema-basic equivalent already in scope here.
    hard_break: {
      group: "inline",
      inline: true,
      selectable: false,
      atom: true,
      parseDOM: [{ tag: "br" }],
      toDOM: () => ["br"],
    },

    // Opaque `#name(...)`/`#name[...]` call, block form: occupies its own
    // paragraph in the source (plan.md "`#` function-call support"). See
    // `typst_call_inline` for the inline form — ProseMirror node types are
    // fixed as either block or inline, so the two placements need distinct
    // node types even though they share the same `{ name, raw }` shape.
    typst_call: {
      group: "block",
      attrs: { name: { default: "" }, raw: { default: "" } },
      atom: true,
      isolating: true,
      selectable: true,
      toDOM: (node) => [
        "div",
        { "data-typst-call": node.attrs.name, contenteditable: "false" },
        `#${node.attrs.name}(...)`,
      ],
    },

    // Opaque `#name(...)`/`#name[...]` call, inline form: embedded in
    // running text rather than standing alone (plan.md "`#` function-call
    // support" — "rendered as a small inert, non-editable chip").
    typst_call_inline: {
      group: "inline",
      inline: true,
      attrs: { name: { default: "" }, raw: { default: "" } },
      atom: true,
      selectable: true,
      toDOM: (node) => [
        "span",
        { "data-typst-call": node.attrs.name, contenteditable: "false" },
        `#${node.attrs.name}(...)`,
      ],
    },

    // `#image("src")` / `#figure(image("src"), caption: [text])` (plan.md
    // M11) — one node either way, `caption` (null when absent) is what
    // distinguishes them; see ast.rs's `AstBlock::Image` doc comment for why
    // a caption is plain text only. `src` is always the relative path as
    // written in the source, never resolved/embedded here — this `toDOM` is
    // just the bare fallback (used by e.g. headless tests with no
    // EditorView); the real WYSIWYG rendering is a custom NodeView in
    // WysiwygEditor.tsx that resolves `src` against the open document's
    // directory via the `read_image_as_data_url` command.
    image: {
      group: "block",
      attrs: { src: { default: "" }, caption: { default: null as string | null } },
      atom: true,
      isolating: true,
      selectable: true,
      toDOM: (node) => [
        "figure",
        { "data-image-src": node.attrs.src as string },
        ["div", { class: "image-placeholder" }, (node.attrs.src as string) || "(no image)"],
        ["figcaption", {}, (node.attrs.caption as string) || ""],
      ],
    },

    text: {
      group: "inline",
    },

    // `#table(columns: .., [cell], ...)` (plan.md M10). `columnsRaw` is the
    // verbatim source text of the `columns:` argument and `columnCount` the
    // column count it was derived for (see ast.rs's `AstBlock::Table`) — the
    // serializer (src/typstAst.ts) re-emits `columnsRaw` verbatim only when
    // `columnCount` still matches the table's *actual* current column count
    // (the first row's cell count), falling back to a plain integer when a
    // WYSIWYG add/remove-column edit has made it stale, rather than silently
    // re-emitting a mismatched columns spec.
    table: {
      ...tableNodeSpecs.table,
      attrs: { columnsRaw: { default: "" }, columnCount: { default: 0 } },
    },
    table_row: tableNodeSpecs.table_row,
    table_cell: tableNodeSpecs.table_cell,
    table_header: tableNodeSpecs.table_header,
  },
  marks: {
    strong: {
      parseDOM: [{ tag: "strong" }, { tag: "b" }],
      toDOM: () => ["strong", 0],
    },
    em: {
      parseDOM: [{ tag: "em" }, { tag: "i" }],
      toDOM: () => ["em", 0],
    },
    code: {
      parseDOM: [{ tag: "code" }],
      toDOM: () => ["code", 0],
    },
    // Typst `#link("href")[...]` / Markdown `[...](href)` (plan.md M9) — a
    // mark, not a node: both source grammars let a link wrap arbitrary
    // marked-up inline content (e.g. a bold link), which a ProseMirror mark
    // (stackable with strong/em/code on the same text) represents directly,
    // unlike `typst_call`'s opaque leaf-node treatment.
    link: {
      attrs: { href: { default: "" } },
      // Typing immediately after a link shouldn't continue it (standard
      // ProseMirror convention for link-like marks).
      inclusive: false,
      parseDOM: [
        {
          tag: "a[href]",
          getAttrs: (dom) => ({ href: (dom as HTMLElement).getAttribute("href") ?? "" }),
        },
      ],
      toDOM: (mark) => ["a", { href: mark.attrs.href as string }, 0],
    },
  },
});
