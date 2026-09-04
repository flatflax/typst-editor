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
  typstSet,
  unsupportedBlockSandwich,
};
