//! `parse_typst_ast` Tauri command (plan.md M3): parses raw Typst source
//! with `typst_syntax::parse` (pure, infallible, no `World` needed) and
//! prunes/simplifies the CST into the JSON shape covering only the MVP
//! syntax subset (plan.md line 31) plus the opaque `typst_call`/
//! `unsupported_block` escape hatches and top-level `#set` lifting. The
//! frontend's `typstAstToDoc` (src/typstAst.ts) maps this into the Editor
//! Model — this module only recognizes structure, it doesn't know about
//! ProseMirror.
//!
//! Typst's CST is *concrete*: an in-order traversal of a node's children
//! reproduces its exact source text (see `typst_syntax::ast` module docs).
//! `SyntaxNode::full_text()` relies on that property, and so does this
//! module's `raw` reconstruction for `typst_call`/`typst_set`/
//! `unsupported_block` — no manual byte-offset bookkeeping is needed.
//!
//! One CST quirk this module works around: the `#` marker before a call or
//! set rule is its own preceding sibling (`SyntaxKind::Hash`), not part of
//! the `FuncCall`/`SetRule` node's own span — so `raw` is built as
//! `format!("#{}", node.full_text())`, and `Hash` tokens are otherwise
//! skipped as content-free punctuation when flattening inline runs.

use serde::Serialize;
use typst_syntax::ast::{self, AstNode};
use typst_syntax::{SyntaxKind, SyntaxNode};

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct TypstSet {
    pub function: String,
    pub raw: String,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct AstDocument {
    pub settings: Vec<TypstSet>,
    pub content: Vec<AstBlock>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AstBlock {
    Heading { level: u8, children: Vec<AstInline> },
    Paragraph { children: Vec<AstInline> },
    BulletList { items: Vec<Vec<AstBlock>> },
    OrderedList { start: u64, items: Vec<Vec<AstBlock>> },
    TypstCall { name: String, raw: String },
    UnsupportedBlock { raw: String },
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AstInline {
    Text { text: String, marks: Vec<String> },
    Linebreak,
    TypstCall { name: String, raw: String },
}

#[tauri::command]
pub fn parse_typst_ast(source: String) -> AstDocument {
    let root = typst_syntax::parse(&source);
    let markup: ast::Markup = root
        .cast()
        .expect("typst_syntax::parse always returns a Markup root");
    let mut settings = Vec::new();
    let content = convert_markup(markup, &mut settings, true);
    AstDocument { settings, content }
}

/// Canonical mark ordering so e.g. bold+italic always serializes marks in
/// the same order regardless of which was applied first in the source —
/// needed for the mapped `AstInline::Text` to be a stable fixed point under
/// repeated parse/serialize.
const MARK_ORDER: [&str; 3] = ["strong", "em", "code"];

fn canonical_marks(marks: &[&str]) -> Vec<String> {
    MARK_ORDER.iter().filter(|m| marks.contains(m)).map(|s| s.to_string()).collect()
}

fn push_text(out: &mut Vec<AstInline>, text: String, marks: &[&str]) {
    out.push(AstInline::Text { text, marks: canonical_marks(marks) });
}

fn callee_name(expr: ast::Expr) -> String {
    match expr {
        ast::Expr::Ident(id) => id.as_str().to_string(),
        other => other.to_untyped().full_text().to_string(),
    }
}

/// Converts a block of markup (the document root, or a list item's body) into
/// MVP-subset blocks, degrading anything outside the subset to a verbatim
/// `unsupported_block` rather than failing the whole parse. `#set` rules are
/// only lifted into `settings` at the document root (`is_root`) — matching
/// the "top-level `#set` rule support" scope decision (plan.md); a `#set`
/// found elsewhere falls through the normal inline handling, which doesn't
/// recognize it either, so it degrades to `unsupported_block` like any other
/// unrecognized construct.
fn convert_markup<'a>(
    markup: ast::Markup<'a>,
    settings: &mut Vec<TypstSet>,
    is_root: bool,
) -> Vec<AstBlock> {
    let children: Vec<&'a SyntaxNode> = markup.to_untyped().children().collect();
    let mut content = Vec::new();
    let mut pending: Vec<&'a SyntaxNode> = Vec::new();
    let mut i = 0;
    while i < children.len() {
        let child = children[i];
        match child.kind() {
            SyntaxKind::Parbreak => {
                finalize_pending(&mut pending, &mut content);
                i += 1;
            }
            SyntaxKind::Heading => {
                finalize_pending(&mut pending, &mut content);
                let heading: ast::Heading = child.cast().expect("kind checked above");
                content.push(convert_heading(heading));
                i += 1;
            }
            SyntaxKind::SetRule if is_root => {
                finalize_pending(&mut pending, &mut content);
                let set_rule: ast::SetRule = child.cast().expect("kind checked above");
                settings.push(TypstSet {
                    function: callee_name(set_rule.target()),
                    raw: format!("#{}", child.full_text()),
                });
                i += 1;
            }
            SyntaxKind::ListItem => {
                finalize_pending(&mut pending, &mut content);
                let (items, end) = gather_same_kind(&children, i, SyntaxKind::ListItem);
                content.push(convert_bullet_list(items, settings));
                i = end;
            }
            SyntaxKind::EnumItem => {
                finalize_pending(&mut pending, &mut content);
                let (items, end) = gather_same_kind(&children, i, SyntaxKind::EnumItem);
                content.push(convert_ordered_list(items, settings));
                i = end;
            }
            _ => {
                pending.push(child);
                i += 1;
            }
        }
    }
    finalize_pending(&mut pending, &mut content);
    content
}

/// Gathers a run of same-kind list items starting at `start`, tolerating a
/// single connecting `Space` (the newline between item lines) between them —
/// observed empirically: consecutive top-level list items are separated by a
/// bare `Space` sibling, not swallowed by the item nodes themselves. Returns
/// the items and the index to resume scanning from (deliberately *not*
/// consuming a trailing Space that isn't followed by another same-kind item,
/// so it flows back into the next `pending` run).
fn gather_same_kind<'a>(
    children: &[&'a SyntaxNode],
    start: usize,
    kind: SyntaxKind,
) -> (Vec<&'a SyntaxNode>, usize) {
    let mut items = vec![children[start]];
    let mut i = start + 1;
    loop {
        let mut j = i;
        if children.get(j).map(|n| n.kind()) == Some(SyntaxKind::Space) {
            j += 1;
        }
        if children.get(j).map(|n| n.kind()) == Some(kind) {
            items.push(children[j]);
            i = j + 1;
        } else {
            break;
        }
    }
    (items, i)
}

fn convert_heading(heading: ast::Heading) -> AstBlock {
    let depth = heading.depth().get();
    if depth > 3 {
        return AstBlock::UnsupportedBlock { raw: heading.to_untyped().full_text().to_string() };
    }
    let mut children = Vec::new();
    if flatten_markup_children(heading.body(), &[], &mut children) {
        AstBlock::Heading { level: depth as u8, children }
    } else {
        AstBlock::UnsupportedBlock { raw: heading.to_untyped().full_text().to_string() }
    }
}

fn convert_bullet_list(items: Vec<&SyntaxNode>, settings: &mut Vec<TypstSet>) -> AstBlock {
    let items = items
        .into_iter()
        .map(|node| {
            let item: ast::ListItem = node.cast().expect("kind checked by gather_same_kind");
            convert_markup(item.body(), settings, false)
        })
        .collect();
    AstBlock::BulletList { items }
}

fn convert_ordered_list(items: Vec<&SyntaxNode>, settings: &mut Vec<TypstSet>) -> AstBlock {
    let start = items
        .first()
        .and_then(|node| node.cast::<ast::EnumItem>())
        .and_then(|item| item.number())
        .unwrap_or(1);
    let items = items
        .into_iter()
        .map(|node| {
            let item: ast::EnumItem = node.cast().expect("kind checked by gather_same_kind");
            convert_markup(item.body(), settings, false)
        })
        .collect();
    AstBlock::OrderedList { start, items }
}

enum FlattenResult {
    /// The whole pending run was a single `#name(...)`/`#name[...]` call
    /// with nothing else alongside it — i.e. it occupies its own paragraph,
    /// so it becomes a block-level `typst_call` rather than an inline one.
    SingleCall(String, String),
    Inline(Vec<AstInline>),
}

fn try_flatten_pending(pending: &[&SyntaxNode]) -> Option<FlattenResult> {
    let significant: Vec<&SyntaxNode> =
        pending.iter().copied().filter(|n| n.kind() != SyntaxKind::Hash).collect();
    if let [only] = significant.as_slice() {
        if let Some(call) = only.cast::<ast::FuncCall>() {
            return Some(FlattenResult::SingleCall(
                callee_name(call.callee()),
                format!("#{}", only.full_text()),
            ));
        }
    }

    let mut inline = Vec::new();
    for node in pending {
        if !flatten_node(node, &[], &mut inline) {
            return None;
        }
    }
    Some(FlattenResult::Inline(inline))
}

fn is_blank_inline(children: &[AstInline]) -> bool {
    children.iter().all(|c| matches!(c, AstInline::Text { text, .. } if text.trim().is_empty()))
}

fn finalize_pending(pending: &mut Vec<&SyntaxNode>, content: &mut Vec<AstBlock>) {
    if pending.is_empty() {
        return;
    }
    match try_flatten_pending(pending) {
        Some(FlattenResult::SingleCall(name, raw)) => {
            content.push(AstBlock::TypstCall { name, raw });
        }
        Some(FlattenResult::Inline(children)) => {
            // A run of pure whitespace (e.g. a lone connecting Space at the
            // very end of the document) carries no meaningful content — drop
            // it rather than emitting an empty paragraph.
            if !is_blank_inline(&children) {
                content.push(AstBlock::Paragraph { children });
            }
        }
        None => {
            let raw: String = pending.iter().map(|n| n.full_text().to_string()).collect();
            content.push(AstBlock::UnsupportedBlock { raw });
        }
    }
    pending.clear();
}

/// Flattens one CST child into inline content, applying `marks` to any text
/// it produces. Returns `false` for anything outside the MVP inline subset
/// (links, labels, refs, math, block raw, comments, ...), signaling the
/// caller to fall back to a verbatim `unsupported_block` for the whole run.
fn flatten_node(node: &SyntaxNode, marks: &[&'static str], out: &mut Vec<AstInline>) -> bool {
    match node.kind() {
        // The `#` marker itself carries no content; it's punctuation
        // introducing a call/set-rule node handled separately.
        SyntaxKind::Hash => true,
        SyntaxKind::Text => {
            let text: ast::Text = node.cast().expect("kind checked above");
            push_text(out, text.get().to_string(), marks);
            true
        }
        // A single in-paragraph newline is visually just inter-word spacing
        // (Typst collapses it the same as a space when laying out text), so
        // normalizing it to " " here doesn't change the rendered result and
        // keeps the mapped model a stable fixed point under re-parsing.
        SyntaxKind::Space => {
            push_text(out, " ".to_string(), marks);
            true
        }
        SyntaxKind::Linebreak => {
            out.push(AstInline::Linebreak);
            true
        }
        SyntaxKind::Escape => {
            let escape: ast::Escape = node.cast().expect("kind checked above");
            push_text(out, escape.get().to_string(), marks);
            true
        }
        SyntaxKind::Shorthand => {
            let shorthand: ast::Shorthand = node.cast().expect("kind checked above");
            push_text(out, shorthand.get().to_string(), marks);
            true
        }
        SyntaxKind::SmartQuote => {
            push_text(out, node.leaf_text().to_string(), marks);
            true
        }
        SyntaxKind::Strong => {
            let strong: ast::Strong = node.cast().expect("kind checked above");
            let mut with_mark = marks.to_vec();
            if !with_mark.contains(&"strong") {
                with_mark.push("strong");
            }
            flatten_markup_children(strong.body(), &with_mark, out)
        }
        SyntaxKind::Emph => {
            let emph: ast::Emph = node.cast().expect("kind checked above");
            let mut with_mark = marks.to_vec();
            if !with_mark.contains(&"em") {
                with_mark.push("em");
            }
            flatten_markup_children(emph.body(), &with_mark, out)
        }
        SyntaxKind::Raw => {
            let raw: ast::Raw = node.cast().expect("kind checked above");
            // Raw *blocks* (fenced, triple-backtick) are explicitly excluded
            // from the MVP subset (plan.md line 31) — only inline code.
            if raw.block() {
                return false;
            }
            let text = raw.lines().map(|line| line.get().to_string()).collect::<Vec<_>>().join("\n");
            let mut with_mark = marks.to_vec();
            if !with_mark.contains(&"code") {
                with_mark.push("code");
            }
            push_text(out, text, &with_mark);
            true
        }
        SyntaxKind::FuncCall => {
            let call: ast::FuncCall = node.cast().expect("kind checked above");
            out.push(AstInline::TypstCall {
                name: callee_name(call.callee()),
                raw: format!("#{}", node.full_text()),
            });
            true
        }
        _ => false,
    }
}

fn flatten_markup_children(
    markup: ast::Markup,
    marks: &[&'static str],
    out: &mut Vec<AstInline>,
) -> bool {
    for child in markup.to_untyped().children() {
        if !flatten_node(child, marks, out) {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(source: &str) -> AstDocument {
        parse_typst_ast(source.to_string())
    }

    #[test]
    fn headings_1_to_3_map_to_heading_blocks() {
        let doc = parse("= One\n\n== Two\n\n=== Three");
        assert_eq!(
            doc.content,
            vec![
                AstBlock::Heading {
                    level: 1,
                    children: vec![AstInline::Text { text: "One".into(), marks: vec![] }]
                },
                AstBlock::Heading {
                    level: 2,
                    children: vec![AstInline::Text { text: "Two".into(), marks: vec![] }]
                },
                AstBlock::Heading {
                    level: 3,
                    children: vec![AstInline::Text { text: "Three".into(), marks: vec![] }]
                },
            ]
        );
    }

    #[test]
    fn heading_level_4_is_outside_the_mvp_subset() {
        let doc = parse("==== Too deep");
        assert_eq!(doc.content, vec![AstBlock::UnsupportedBlock { raw: "==== Too deep".into() }]);
    }

    #[test]
    fn paragraph_carries_strong_em_and_code_marks() {
        let doc = parse("plain *bold* _italic_ `code` *_bold italic_*");
        let AstBlock::Paragraph { children } = &doc.content[0] else {
            panic!("expected a paragraph, got {:?}", doc.content[0]);
        };
        assert_eq!(
            children,
            &vec![
                AstInline::Text { text: "plain".into(), marks: vec![] },
                AstInline::Text { text: " ".into(), marks: vec![] },
                AstInline::Text { text: "bold".into(), marks: vec!["strong".into()] },
                AstInline::Text { text: " ".into(), marks: vec![] },
                AstInline::Text { text: "italic".into(), marks: vec!["em".into()] },
                AstInline::Text { text: " ".into(), marks: vec![] },
                AstInline::Text { text: "code".into(), marks: vec!["code".into()] },
                AstInline::Text { text: " ".into(), marks: vec![] },
                AstInline::Text {
                    text: "bold italic".into(),
                    marks: vec!["strong".into(), "em".into()]
                },
            ]
        );
    }

    #[test]
    fn hard_linebreak_is_preserved() {
        let doc = parse("line one \\\nline two");
        let AstBlock::Paragraph { children } = &doc.content[0] else {
            panic!("expected a paragraph, got {:?}", doc.content[0]);
        };
        assert!(children.contains(&AstInline::Linebreak), "{children:?}");
    }

    #[test]
    fn nested_bullet_list_matches_the_source_structure() {
        let doc = parse("- Apple\n- Banana\n  - Sub item\n  - Another sub item\n- Orange\n");
        let AstBlock::BulletList { items } = &doc.content[0] else {
            panic!("expected a bullet list, got {:?}", doc.content[0]);
        };
        assert_eq!(items.len(), 3);
        assert_eq!(
            items[0],
            vec![AstBlock::Paragraph {
                children: vec![AstInline::Text { text: "Apple".into(), marks: vec![] }]
            }]
        );
        // Banana's item body has its own paragraph plus a nested bullet list.
        assert_eq!(items[1].len(), 2);
        assert!(matches!(items[1][0], AstBlock::Paragraph { .. }));
        let AstBlock::BulletList { items: nested } = &items[1][1] else {
            panic!("expected a nested bullet list, got {:?}", items[1][1]);
        };
        assert_eq!(nested.len(), 2);
    }

    #[test]
    fn ordered_list_defaults_to_start_1() {
        let doc = parse("+ First\n+ Second\n");
        assert_eq!(
            doc.content[0],
            AstBlock::OrderedList {
                start: 1,
                items: vec![
                    vec![AstBlock::Paragraph {
                        children: vec![AstInline::Text { text: "First".into(), marks: vec![] }]
                    }],
                    vec![AstBlock::Paragraph {
                        children: vec![AstInline::Text { text: "Second".into(), marks: vec![] }]
                    }],
                ]
            }
        );
    }

    /// Regression guard for a user-reported bug ("all three items showed
    /// the same '1.'"): a heading directly followed by a `+`-marked list,
    /// with *no* blank line between them. Passes today — parse_typst_ast
    /// correctly produces one `OrderedList` with 3 sequential items — so
    /// this pins the parse half as correct and narrows the search for
    /// wherever the actual reported bug lives (not reproduced elsewhere
    /// either: typstAstToDoc/pmDocToTypst and a live-app Playwright pass
    /// both showed correct 1/2/3 for this exact input).
    #[test]
    fn ordered_list_immediately_after_a_heading_with_no_blank_line() {
        let doc = parse("== 有序列表\n+ 第一步\n+ 第二步\n+ 第三步\n");
        assert_eq!(
            doc.content,
            vec![
                AstBlock::Heading {
                    level: 2,
                    children: vec![AstInline::Text { text: "有序列表".into(), marks: vec![] }],
                },
                AstBlock::OrderedList {
                    start: 1,
                    items: vec![
                        vec![AstBlock::Paragraph {
                            children: vec![AstInline::Text { text: "第一步".into(), marks: vec![] }]
                        }],
                        vec![AstBlock::Paragraph {
                            children: vec![AstInline::Text { text: "第二步".into(), marks: vec![] }]
                        }],
                        vec![AstBlock::Paragraph {
                            children: vec![AstInline::Text { text: "第三步".into(), marks: vec![] }]
                        }],
                    ],
                },
            ]
        );
    }

    #[test]
    fn ordered_list_with_explicit_start_number() {
        let doc = parse("5. Fifth\n6. Sixth\n");
        let AstBlock::OrderedList { start, .. } = &doc.content[0] else {
            panic!("expected an ordered list, got {:?}", doc.content[0]);
        };
        assert_eq!(*start, 5);
    }

    #[test]
    fn standalone_call_becomes_a_block_typst_call() {
        let doc = parse("#line(length: 100%)");
        assert_eq!(
            doc.content,
            vec![AstBlock::TypstCall {
                name: "line".into(),
                raw: "#line(length: 100%)".into()
            }]
        );
    }

    #[test]
    fn call_embedded_in_running_text_becomes_an_inline_typst_call() {
        let doc = parse("Inline #emph[call] here.");
        let AstBlock::Paragraph { children } = &doc.content[0] else {
            panic!("expected a paragraph, got {:?}", doc.content[0]);
        };
        assert!(
            children.contains(&AstInline::TypstCall {
                name: "emph".into(),
                raw: "#emph[call]".into()
            }),
            "{children:?}"
        );
    }

    #[test]
    fn top_level_set_rule_is_lifted_into_settings_and_excluded_from_content() {
        let doc = parse("#set text(size: 11pt)\n\n= Heading");
        assert_eq!(
            doc.settings,
            vec![TypstSet { function: "text".into(), raw: "#set text(size: 11pt)".into() }]
        );
        assert_eq!(
            doc.content,
            vec![AstBlock::Heading {
                level: 1,
                children: vec![AstInline::Text { text: "Heading".into(), marks: vec![] }]
            }]
        );
    }

    #[test]
    fn math_equation_falls_back_to_an_unsupported_block() {
        let doc = parse("$ x^2 + 1 $");
        assert_eq!(doc.content, vec![AstBlock::UnsupportedBlock { raw: "$ x^2 + 1 $".into() }]);
    }

    #[test]
    fn raw_block_falls_back_to_an_unsupported_block() {
        let doc = parse("```rust\nfn main() {}\n```");
        assert_eq!(
            doc.content,
            vec![AstBlock::UnsupportedBlock { raw: "```rust\nfn main() {}\n```".into() }]
        );
    }

    #[test]
    fn unsupported_construct_does_not_swallow_surrounding_paragraphs() {
        let doc = parse("Before.\n\n$ x^2 $\n\nAfter.");
        assert_eq!(
            doc.content,
            vec![
                AstBlock::Paragraph {
                    children: vec![AstInline::Text { text: "Before.".into(), marks: vec![] }]
                },
                AstBlock::UnsupportedBlock { raw: "$ x^2 $".into() },
                AstBlock::Paragraph {
                    children: vec![AstInline::Text { text: "After.".into(), marks: vec![] }]
                },
            ]
        );
    }

    /// A single document exercising every MVP-subset construct at once
    /// (plan.md M6: "extend M3/M4 fixtures to cover mixed content and at
    /// least one unsupported_block case") — headings, marks, nested and
    /// ordered lists, a block and an inline `typst_call`, a top-level
    /// `#set`, and a math equation as the `unsupported_block`. Mirrored by
    /// the `mixed` fixture in src/typstAst.fixtures.ts (same source string)
    /// and by src/markdown.test.ts's markdown-side equivalent.
    const MIXED_DOCUMENT: &str = "\
#set text(size: 11pt)

= Report

Some *bold* and _italic_ and `code` text.

- Apple
- Banana
  - Nested one
  - Nested two

+ Step one
+ Step two

#line(length: 100%)

Inline call: #emph[hi] here.

$ x^2 $
";

    #[test]
    fn mixed_document_combines_every_mvp_construct() {
        let doc = parse(MIXED_DOCUMENT);
        assert_eq!(
            doc,
            AstDocument {
                settings: vec![TypstSet {
                    function: "text".into(),
                    raw: "#set text(size: 11pt)".into(),
                }],
                content: vec![
                    AstBlock::Heading {
                        level: 1,
                        children: vec![AstInline::Text { text: "Report".into(), marks: vec![] }],
                    },
                    AstBlock::Paragraph {
                        children: vec![
                            AstInline::Text { text: "Some".into(), marks: vec![] },
                            AstInline::Text { text: " ".into(), marks: vec![] },
                            AstInline::Text {
                                text: "bold".into(),
                                marks: vec!["strong".into()],
                            },
                            AstInline::Text { text: " ".into(), marks: vec![] },
                            AstInline::Text { text: "and".into(), marks: vec![] },
                            AstInline::Text { text: " ".into(), marks: vec![] },
                            AstInline::Text { text: "italic".into(), marks: vec!["em".into()] },
                            AstInline::Text { text: " ".into(), marks: vec![] },
                            AstInline::Text { text: "and".into(), marks: vec![] },
                            AstInline::Text { text: " ".into(), marks: vec![] },
                            AstInline::Text {
                                text: "code".into(),
                                marks: vec!["code".into()],
                            },
                            AstInline::Text { text: " ".into(), marks: vec![] },
                            AstInline::Text { text: "text.".into(), marks: vec![] },
                        ],
                    },
                    AstBlock::BulletList {
                        items: vec![
                            vec![AstBlock::Paragraph {
                                children: vec![AstInline::Text {
                                    text: "Apple".into(),
                                    marks: vec![],
                                }],
                            }],
                            vec![
                                AstBlock::Paragraph {
                                    children: vec![
                                        AstInline::Text { text: "Banana".into(), marks: vec![] },
                                        AstInline::Text { text: " ".into(), marks: vec![] },
                                    ],
                                },
                                AstBlock::BulletList {
                                    items: vec![
                                        vec![AstBlock::Paragraph {
                                            children: vec![AstInline::Text {
                                                text: "Nested one".into(),
                                                marks: vec![],
                                            }],
                                        }],
                                        vec![AstBlock::Paragraph {
                                            children: vec![AstInline::Text {
                                                text: "Nested two".into(),
                                                marks: vec![],
                                            }],
                                        }],
                                    ],
                                },
                            ],
                        ],
                    },
                    AstBlock::OrderedList {
                        start: 1,
                        items: vec![
                            vec![AstBlock::Paragraph {
                                children: vec![AstInline::Text {
                                    text: "Step one".into(),
                                    marks: vec![],
                                }],
                            }],
                            vec![AstBlock::Paragraph {
                                children: vec![AstInline::Text {
                                    text: "Step two".into(),
                                    marks: vec![],
                                }],
                            }],
                        ],
                    },
                    AstBlock::TypstCall {
                        name: "line".into(),
                        raw: "#line(length: 100%)".into(),
                    },
                    AstBlock::Paragraph {
                        children: vec![
                            AstInline::Text { text: "Inline call".into(), marks: vec![] },
                            AstInline::Text { text: ":".into(), marks: vec![] },
                            AstInline::Text { text: " ".into(), marks: vec![] },
                            AstInline::TypstCall {
                                name: "emph".into(),
                                raw: "#emph[hi]".into(),
                            },
                            AstInline::Text { text: " ".into(), marks: vec![] },
                            AstInline::Text { text: "here.".into(), marks: vec![] },
                        ],
                    },
                    AstBlock::UnsupportedBlock { raw: "$ x^2 $\n".into() },
                ],
            }
        );
    }

    // See compile.rs's own copy of this same source (private CompileResult
    // fields mean the compile-diff + perf tests for it have to live there)
    // for mixed_document_compiles_successfully and
    // compiling_an_mvp_sized_document_is_well_under_the_debounce_window.
}
