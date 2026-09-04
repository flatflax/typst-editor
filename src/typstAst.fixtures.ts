// Paired (Typst source, AstDocument) fixtures for typstAst.test.ts.
//
// There's no bridge from vitest into the real `parse_typst_ast` Rust command
// (no Tauri runtime in unit tests), so the parse half (source -> AstDocument)
// and the map/serialize half (AstDocument -> PMDoc -> source) are verified in
// separate test suites that share these exact literals: the Rust half is
// pinned by same-named `#[test]`s in src-tauri/src/ast.rs asserting
// `parse_typst_ast(source) == ast`; this file supplies the `ast` side and the
// `source` each is expected to serialize back to. Together they prove the
// full parse -> map -> serialize loop by construction, without needing a
// cross-language test runner.
import type { AstDocument } from "./typstAst";

export type TypstAstFixture = {
  /** The original Typst source (also used as a Rust-side test literal). */
  source: string;
  /** What `parse_typst_ast(source)` produces (pinned by a same-named Rust test). */
  ast: AstDocument;
  /** What `pmDocToTypst(typstAstToDoc(ast))` is expected to produce. */
  expected: string;
};

// See ast::tests::headings_1_to_3_map_to_heading_blocks
export const headings: TypstAstFixture = {
  source: "= One\n\n== Two\n\n=== Three",
  ast: {
    settings: [],
    content: [
      { type: "heading", level: 1, children: [{ type: "text", text: "One", marks: [] }] },
      { type: "heading", level: 2, children: [{ type: "text", text: "Two", marks: [] }] },
      { type: "heading", level: 3, children: [{ type: "text", text: "Three", marks: [] }] },
    ],
  },
  expected: "= One\n\n== Two\n\n=== Three",
};

// See ast::tests::heading_level_4_is_outside_the_mvp_subset
export const headingLevel4Unsupported: TypstAstFixture = {
  source: "==== Too deep",
  ast: { settings: [], content: [{ type: "unsupported_block", raw: "==== Too deep" }] },
  expected: "==== Too deep",
};

// See ast::tests::paragraph_carries_strong_em_and_code_marks
export const marks: TypstAstFixture = {
  source: "plain *bold* _italic_ `code` *_bold italic_*",
  ast: {
    settings: [],
    content: [
      {
        type: "paragraph",
        children: [
          { type: "text", text: "plain", marks: [] },
          { type: "text", text: " ", marks: [] },
          { type: "text", text: "bold", marks: ["strong"] },
          { type: "text", text: " ", marks: [] },
          { type: "text", text: "italic", marks: ["em"] },
          { type: "text", text: " ", marks: [] },
          { type: "text", text: "code", marks: ["code"] },
          { type: "text", text: " ", marks: [] },
          { type: "text", text: "bold italic", marks: ["strong", "em"] },
        ],
      },
    ],
  },
  expected: "plain *bold* _italic_ `code` *_bold italic_*",
};

// See ast::tests::hard_linebreak_is_preserved
export const hardLinebreak: TypstAstFixture = {
  source: "line one \\\nline two",
  ast: {
    settings: [],
    content: [
      {
        type: "paragraph",
        children: [
          { type: "text", text: "line one ", marks: [] },
          { type: "linebreak" },
          { type: "text", text: "line two", marks: [] },
        ],
      },
    ],
  },
  expected: "line one \\\nline two",
};

// See ast::tests::nested_bullet_list_matches_the_source_structure
export const nestedBulletList: TypstAstFixture = {
  source: "- Apple\n- Banana\n  - Sub item\n  - Another sub item\n- Orange",
  ast: {
    settings: [],
    content: [
      {
        type: "bullet_list",
        items: [
          [{ type: "paragraph", children: [{ type: "text", text: "Apple", marks: [] }] }],
          [
            { type: "paragraph", children: [{ type: "text", text: "Banana", marks: [] }] },
            {
              type: "bullet_list",
              items: [
                [
                  {
                    type: "paragraph",
                    children: [{ type: "text", text: "Sub item", marks: [] }],
                  },
                ],
                [
                  {
                    type: "paragraph",
                    children: [{ type: "text", text: "Another sub item", marks: [] }],
                  },
                ],
              ],
            },
          ],
          [{ type: "paragraph", children: [{ type: "text", text: "Orange", marks: [] }] }],
        ],
      },
    ],
  },
  expected: "- Apple\n- Banana\n  - Sub item\n  - Another sub item\n- Orange",
};

// See ast::tests::ordered_list_defaults_to_start_1
export const orderedListDefault: TypstAstFixture = {
  source: "+ First\n+ Second",
  ast: {
    settings: [],
    content: [
      {
        type: "ordered_list",
        start: 1,
        items: [
          [{ type: "paragraph", children: [{ type: "text", text: "First", marks: [] }] }],
          [{ type: "paragraph", children: [{ type: "text", text: "Second", marks: [] }] }],
        ],
      },
    ],
  },
  expected: "1. First\n2. Second",
};

// See ast::tests::ordered_list_with_explicit_start_number
export const orderedListWithStart: TypstAstFixture = {
  source: "5. Fifth\n6. Sixth",
  ast: {
    settings: [],
    content: [
      {
        type: "ordered_list",
        start: 5,
        items: [
          [{ type: "paragraph", children: [{ type: "text", text: "Fifth", marks: [] }] }],
          [{ type: "paragraph", children: [{ type: "text", text: "Sixth", marks: [] }] }],
        ],
      },
    ],
  },
  expected: "5. Fifth\n6. Sixth",
};

// See ast::tests::standalone_call_becomes_a_block_typst_call
export const typstCallBlock: TypstAstFixture = {
  source: "#line(length: 100%)",
  ast: {
    settings: [],
    content: [{ type: "typst_call", name: "line", raw: "#line(length: 100%)" }],
  },
  expected: "#line(length: 100%)",
};

// See ast::tests::call_embedded_in_running_text_becomes_an_inline_typst_call
export const typstCallInline: TypstAstFixture = {
  source: "Inline #emph[call] here.",
  ast: {
    settings: [],
    content: [
      {
        type: "paragraph",
        children: [
          { type: "text", text: "Inline", marks: [] },
          { type: "text", text: " ", marks: [] },
          { type: "typst_call", name: "emph", raw: "#emph[call]" },
          { type: "text", text: " ", marks: [] },
          { type: "text", text: "here.", marks: [] },
        ],
      },
    ],
  },
  expected: "Inline #emph[call] here.",
};

// See ast::tests::link_inside_running_text_becomes_an_inline_link
export const linkInline: TypstAstFixture = {
  source: 'See #link("https://typst.app")[the docs] for more.',
  ast: {
    settings: [],
    content: [
      {
        type: "paragraph",
        children: [
          { type: "text", text: "See", marks: [] },
          { type: "text", text: " ", marks: [] },
          {
            type: "link",
            href: "https://typst.app",
            children: [{ type: "text", text: "the docs", marks: [] }],
          },
          { type: "text", text: " ", marks: [] },
          { type: "text", text: "for more.", marks: [] },
        ],
      },
    ],
  },
  expected: 'See #link("https://typst.app")[the docs] for more.',
};

// See ast::tests::standalone_link_paragraph_is_not_treated_as_an_opaque_block_call
export const linkStandalone: TypstAstFixture = {
  source: '#link("https://typst.app")[Typst]',
  ast: {
    settings: [],
    content: [
      {
        type: "paragraph",
        children: [
          {
            type: "link",
            href: "https://typst.app",
            children: [{ type: "text", text: "Typst", marks: [] }],
          },
        ],
      },
    ],
  },
  expected: '#link("https://typst.app")[Typst]',
};

// See ast::tests::bold_text_inside_a_link_keeps_the_strong_mark AND
// ast::tests::a_link_nested_inside_bold_carries_the_strong_mark_on_its_text —
// both `#link("...")[*Typst*]` and `*#link("...")[Typst]*` parse to this
// exact AST (marks always nest inside the link in the mapped model — see
// typstAst.ts's withLinkMark), so both are pinned by the same fixture here;
// the second is only exercised on the Rust-parse side, not re-declared here.
export const linkWithBoldText: TypstAstFixture = {
  source: '#link("https://typst.app")[*Typst*]',
  ast: {
    settings: [],
    content: [
      {
        type: "paragraph",
        children: [
          {
            type: "link",
            href: "https://typst.app",
            children: [{ type: "text", text: "Typst", marks: ["strong"] }],
          },
        ],
      },
    ],
  },
  expected: '#link("https://typst.app")[*Typst*]',
};

// See ast::tests::table_with_integer_columns_becomes_a_structured_table
export const table: TypstAstFixture = {
  source: "#table(columns: 2, [A], [B], [C], [D])",
  ast: {
    settings: [],
    content: [
      {
        type: "table",
        columnsRaw: "2",
        columnCount: 2,
        cells: [
          [{ type: "paragraph", children: [{ type: "text", text: "A", marks: [] }] }],
          [{ type: "paragraph", children: [{ type: "text", text: "B", marks: [] }] }],
          [{ type: "paragraph", children: [{ type: "text", text: "C", marks: [] }] }],
          [{ type: "paragraph", children: [{ type: "text", text: "D", marks: [] }] }],
        ],
      },
    ],
  },
  expected: "#table(columns: 2, [A], [B], [C], [D])",
};

// See ast::tests::table_with_array_columns_preserves_the_raw_width_spec —
// the array form's exact source text round-trips verbatim.
export const tableWithArrayColumns: TypstAstFixture = {
  source: "#table(columns: (1fr, 2fr), [A], [B])",
  ast: {
    settings: [],
    content: [
      {
        type: "table",
        columnsRaw: "(1fr, 2fr)",
        columnCount: 2,
        cells: [
          [{ type: "paragraph", children: [{ type: "text", text: "A", marks: [] }] }],
          [{ type: "paragraph", children: [{ type: "text", text: "B", marks: [] }] }],
        ],
      },
    ],
  },
  expected: "#table(columns: (1fr, 2fr), [A], [B])",
};

// See ast::tests::a_table_cell_can_contain_marked_up_text (plan.md M10:
// "including one table with mixed inline marks in a cell").
export const tableWithMarkedUpCell: TypstAstFixture = {
  source: "#table(columns: 1, [*bold* and _italic_])",
  ast: {
    settings: [],
    content: [
      {
        type: "table",
        columnsRaw: "1",
        columnCount: 1,
        cells: [
          [
            {
              type: "paragraph",
              children: [
                { type: "text", text: "bold", marks: ["strong"] },
                { type: "text", text: " ", marks: [] },
                { type: "text", text: "and", marks: [] },
                { type: "text", text: " ", marks: [] },
                { type: "text", text: "italic", marks: ["em"] },
              ],
            },
          ],
        ],
      },
    ],
  },
  expected: "#table(columns: 1, [*bold* and _italic_])",
};

// See ast::tests::bare_image_call_has_no_caption
export const imageNoCaption: TypstAstFixture = {
  source: '#image("photo.png")',
  ast: { settings: [], content: [{ type: "image", src: "photo.png", caption: null }] },
  expected: '#image("photo.png")',
};

// See ast::tests::figure_with_caption_becomes_an_image_with_that_caption
export const imageWithCaption: TypstAstFixture = {
  source: '#figure(image("photo.png"), caption: [A nice photo])',
  ast: {
    settings: [],
    content: [{ type: "image", src: "photo.png", caption: "A nice photo" }],
  },
  expected: '#figure(image("photo.png"), caption: [A nice photo])',
};

// See ast::tests::top_level_set_rule_is_lifted_into_settings_and_excluded_from_content
export const typstSet: TypstAstFixture = {
  source: "#set text(size: 11pt)\n\n= Heading",
  ast: {
    settings: [{ function: "text", raw: "#set text(size: 11pt)" }],
    content: [
      { type: "heading", level: 1, children: [{ type: "text", text: "Heading", marks: [] }] },
    ],
  },
  expected: "#set text(size: 11pt)\n\n= Heading",
};

// See ast::tests::unsupported_construct_does_not_swallow_surrounding_paragraphs
export const unsupportedBlockSandwich: TypstAstFixture = {
  source: "Before.\n\n$ x^2 $\n\nAfter.",
  ast: {
    settings: [],
    content: [
      { type: "paragraph", children: [{ type: "text", text: "Before.", marks: [] }] },
      { type: "unsupported_block", raw: "$ x^2 $" },
      { type: "paragraph", children: [{ type: "text", text: "After.", marks: [] }] },
    ],
  },
  expected: "Before.\n\n$ x^2 $\n\nAfter.",
};

// See ast::tests::mixed_document_combines_every_mvp_construct (plan.md M6:
// "extend M3/M4 fixtures to cover mixed content and at least one
// unsupported_block case") — every MVP construct in one document. Also
// compiled successfully through the real Typst engine in
// compile::tests::mixed_document_compiles_successfully, on the Rust side.
export const mixed: TypstAstFixture = {
  source: `#set text(size: 11pt)

= Report

Some *bold* and _italic_ and \`code\` text.

- Apple
- Banana
  - Nested one
  - Nested two

+ Step one
+ Step two

#line(length: 100%)

Inline call: #emph[hi] here.

$ x^2 $
`,
  ast: {
    settings: [{ function: "text", raw: "#set text(size: 11pt)" }],
    content: [
      { type: "heading", level: 1, children: [{ type: "text", text: "Report", marks: [] }] },
      {
        type: "paragraph",
        children: [
          { type: "text", text: "Some", marks: [] },
          { type: "text", text: " ", marks: [] },
          { type: "text", text: "bold", marks: ["strong"] },
          { type: "text", text: " ", marks: [] },
          { type: "text", text: "and", marks: [] },
          { type: "text", text: " ", marks: [] },
          { type: "text", text: "italic", marks: ["em"] },
          { type: "text", text: " ", marks: [] },
          { type: "text", text: "and", marks: [] },
          { type: "text", text: " ", marks: [] },
          { type: "text", text: "code", marks: ["code"] },
          { type: "text", text: " ", marks: [] },
          { type: "text", text: "text.", marks: [] },
        ],
      },
      {
        type: "bullet_list",
        items: [
          [{ type: "paragraph", children: [{ type: "text", text: "Apple", marks: [] }] }],
          [
            {
              type: "paragraph",
              children: [
                { type: "text", text: "Banana", marks: [] },
                { type: "text", text: " ", marks: [] },
              ],
            },
            {
              type: "bullet_list",
              items: [
                [
                  {
                    type: "paragraph",
                    children: [{ type: "text", text: "Nested one", marks: [] }],
                  },
                ],
                [
                  {
                    type: "paragraph",
                    children: [{ type: "text", text: "Nested two", marks: [] }],
                  },
                ],
              ],
            },
          ],
        ],
      },
      {
        type: "ordered_list",
        start: 1,
        items: [
          [{ type: "paragraph", children: [{ type: "text", text: "Step one", marks: [] }] }],
          [{ type: "paragraph", children: [{ type: "text", text: "Step two", marks: [] }] }],
        ],
      },
      { type: "typst_call", name: "line", raw: "#line(length: 100%)" },
      {
        type: "paragraph",
        children: [
          { type: "text", text: "Inline call", marks: [] },
          { type: "text", text: ":", marks: [] },
          { type: "text", text: " ", marks: [] },
          { type: "typst_call", name: "emph", raw: "#emph[hi]" },
          { type: "text", text: " ", marks: [] },
          { type: "text", text: "here.", marks: [] },
        ],
      },
      { type: "unsupported_block", raw: "$ x^2 $\n" },
    ],
  },
  // Not byte-identical to `source`: `+` markers canonicalize to explicit
  // "1."/"2." (see pmDocToTypst's serializeList), and the trailing space
  // after "Banana" is the mapped-back newline that separated it from the
  // nested list in the original source (a single in-paragraph newline maps
  // to a literal space — see ast.rs's flatten_node doc comment). Still a
  // stable fixed point, and (per mixed_document_compiles_successfully on
  // the Rust side) still compiles the same document either way.
  expected:
    "#set text(size: 11pt)\n\n= Report\n\nSome *bold* and _italic_ and `code` text." +
    "\n\n- Apple\n- Banana \n  - Nested one\n  - Nested two\n\n1. Step one\n2. Step two" +
    "\n\n#line(length: 100%)\n\nInline call: #emph[hi] here.\n\n$ x^2 $\n",
};

export const fixtures = {
  headings,
  headingLevel4Unsupported,
  marks,
  hardLinebreak,
  nestedBulletList,
  orderedListDefault,
  orderedListWithStart,
  typstCallBlock,
  typstCallInline,
  linkInline,
  linkStandalone,
  linkWithBoldText,
  table,
  tableWithArrayColumns,
  tableWithMarkedUpCell,
  imageNoCaption,
  imageWithCaption,
  typstSet,
  unsupportedBlockSandwich,
  mixed,
};
