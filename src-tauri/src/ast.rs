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
    /// `#table(columns: .., [cell], [cell], ...)` (plan.md M10). `cells` is
    /// the flat row-major sequence exactly as Typst's call arguments give
    /// it — `cells.len()` is always an exact multiple of `column_count`
    /// (enforced by `as_table_call`); the frontend (src/typstAst.ts) chunks
    /// it into rows for the ProseMirror `table`/`table_row`/`table_cell`
    /// nodes. `columns_raw` is the verbatim source text of the `columns:`
    /// argument (an int or an array literal, e.g. `"3"` or `"(1fr, 2fr)"`)
    /// — carried through unparsed/unevaluated like `typst_call`'s `raw`, so
    /// per-column width styling round-trips byte-exact even though this
    /// module only derives a plain `column_count` from it for structure.
    Table { columns_raw: String, column_count: usize, cells: Vec<Vec<AstBlock>> },
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AstInline {
    Text { text: String, marks: Vec<String> },
    Linebreak,
    TypstCall { name: String, raw: String },
    /// `#link("href")[body]` (plan.md M9). Unlike `strong`/`em`/`code` this
    /// isn't flattened into `Text.marks` — a mark is a bare name, but a link
    /// carries a URL, and its body can itself contain arbitrary marked-up
    /// inline content — so it's a recursive container instead, mirroring
    /// how `AstBlock::BulletList` nests rather than flattens. The frontend
    /// (src/typstAst.ts) maps this onto a ProseMirror `link` *mark* applied
    /// to every leaf produced by `children`, since ProseMirror has no
    /// separate "link node" concept for inline content.
    Link { href: String, children: Vec<AstInline> },
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
                finalize_pending(&mut pending, &mut content, settings);
                i += 1;
            }
            SyntaxKind::Heading => {
                finalize_pending(&mut pending, &mut content, settings);
                let heading: ast::Heading = child.cast().expect("kind checked above");
                content.push(convert_heading(heading));
                i += 1;
            }
            SyntaxKind::SetRule if is_root => {
                finalize_pending(&mut pending, &mut content, settings);
                let set_rule: ast::SetRule = child.cast().expect("kind checked above");
                settings.push(TypstSet {
                    function: callee_name(set_rule.target()),
                    raw: format!("#{}", child.full_text()),
                });
                i += 1;
            }
            SyntaxKind::ListItem => {
                finalize_pending(&mut pending, &mut content, settings);
                let (items, end) = gather_same_kind(&children, i, SyntaxKind::ListItem);
                content.push(convert_bullet_list(items, settings));
                i = end;
            }
            SyntaxKind::EnumItem => {
                finalize_pending(&mut pending, &mut content, settings);
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
    finalize_pending(&mut pending, &mut content, settings);
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
    /// Same "occupies its own paragraph, alone" shape as `SingleCall`, but
    /// recognized as a structured table (plan.md M10) — always an
    /// `AstBlock::Table`.
    SingleTable(AstBlock),
    Inline(Vec<AstInline>),
}

/// Recognizes `#link("url")[body]` (and its non-bracket-sugar equivalent
/// `link("url", [body])` — both parse to the same two positional args) as a
/// first-class construct rather than falling through to the opaque
/// `typst_call` treatment `flatten_node`'s generic `FuncCall` arm gives
/// every other call: it's the only inline construct in the MVP subset
/// besides marks that isn't opaque, since it becomes a real `link` mark on
/// the ProseMirror side instead of an inert chip. Returns the URL and body
/// markup on a match; `None` for anything else (a bare `#link("url")`, a
/// non-string destination like a label, extra/named arguments, ...), which
/// then degrades to the normal opaque path.
fn as_link_call(node: &SyntaxNode) -> Option<(String, ast::Markup<'_>)> {
    let call = node.cast::<ast::FuncCall>()?;
    if callee_name(call.callee()) != "link" {
        return None;
    }
    let mut items = call.args().items();
    let first = items.next()?;
    let second = items.next()?;
    if items.next().is_some() {
        return None; // extra args (e.g. a `body:`/other named arg) - opaque
    }
    let ast::Arg::Pos(ast::Expr::Str(url)) = first else { return None };
    let ast::Arg::Pos(ast::Expr::ContentBlock(body)) = second else { return None };
    Some((url.get().to_string(), body.body()))
}

/// Recognizes `#table(columns: <int|array>, [cell], [cell], ...)` as a
/// structured table (plan.md M10), not opaque: every argument must be
/// either the (exactly one) `columns:` named argument or a positional
/// content-block cell — no `#table.cell`, rowspan/colspan, or any other
/// named/styling argument (`stroke:`, `fill:`, `align:`, `gutter:`, ...)
/// falls through to the opaque `typst_call` path, same spirit as
/// `as_link_call`. The cell count must be a positive exact multiple of the
/// column count (a ragged/ambiguous grid also falls back). Returns the
/// verbatim `columns:` source text, the derived column count, and each
/// cell's body markup (still unparsed — the caller recurses through the
/// normal subset parser to get each cell's `Vec<AstBlock>`, same as a list
/// item's body).
fn as_table_call<'a>(node: &'a SyntaxNode) -> Option<(String, usize, Vec<ast::Markup<'a>>)> {
    let call = node.cast::<ast::FuncCall>()?;
    if callee_name(call.callee()) != "table" {
        return None;
    }
    let mut columns: Option<(String, usize)> = None;
    let mut cells = Vec::new();
    for arg in call.args().items() {
        match arg {
            ast::Arg::Named(named) if named.name().as_str() == "columns" => {
                if columns.is_some() {
                    return None; // duplicate `columns:` - malformed
                }
                columns = Some(column_count_from(named.expr())?);
            }
            ast::Arg::Pos(ast::Expr::ContentBlock(cb)) => cells.push(cb.body()),
            _ => return None, // any other named arg, or a non-content-block positional
        }
    }
    let (columns_raw, column_count) = columns?;
    if cells.is_empty() || cells.len() % column_count != 0 {
        return None;
    }
    Some((columns_raw, column_count, cells))
}

/// Derives a column count from the `columns:` argument's value: a bare
/// positive integer (`columns: 3`) is that many equal-width columns; an
/// array literal (`columns: (1fr, 2fr, auto)`) has one column per item (a
/// spread item makes the count statically unknowable, so that's excluded).
/// Anything else (a bare length like `columns: 1fr`, a function call, ...)
/// isn't a shape this module evaluates. Returns the argument's exact source
/// text alongside the count — see `AstBlock::Table`'s doc comment for why.
fn column_count_from(expr: ast::Expr) -> Option<(String, usize)> {
    match expr {
        ast::Expr::Int(int) => {
            let n = int.get();
            (n > 0).then(|| (int.to_untyped().full_text().to_string(), n as usize))
        }
        ast::Expr::Array(array) => {
            let mut count = 0usize;
            for item in array.items() {
                match item {
                    ast::ArrayItem::Pos(_) => count += 1,
                    ast::ArrayItem::Spread(_) => return None,
                }
            }
            (count > 0).then(|| (array.to_untyped().full_text().to_string(), count))
        }
        _ => None,
    }
}

fn try_flatten_pending(pending: &[&SyntaxNode], settings: &mut Vec<TypstSet>) -> Option<FlattenResult> {
    let significant: Vec<&SyntaxNode> =
        pending.iter().copied().filter(|n| n.kind() != SyntaxKind::Hash).collect();
    if let [only] = significant.as_slice() {
        if let Some((columns_raw, column_count, cell_bodies)) = as_table_call(only) {
            let cells = cell_bodies
                .into_iter()
                .map(|body| convert_markup(body, settings, false))
                .collect();
            return Some(FlattenResult::SingleTable(AstBlock::Table {
                columns_raw,
                column_count,
                cells,
            }));
        }
        if as_link_call(only).is_none() {
            if let Some(call) = only.cast::<ast::FuncCall>() {
                return Some(FlattenResult::SingleCall(
                    callee_name(call.callee()),
                    format!("#{}", only.full_text()),
                ));
            }
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

fn finalize_pending(pending: &mut Vec<&SyntaxNode>, content: &mut Vec<AstBlock>, settings: &mut Vec<TypstSet>) {
    if pending.is_empty() {
        return;
    }
    match try_flatten_pending(pending, settings) {
        Some(FlattenResult::SingleCall(name, raw)) => {
            content.push(AstBlock::TypstCall { name, raw });
        }
        Some(FlattenResult::SingleTable(table)) => {
            content.push(table);
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
            if let Some((href, body)) = as_link_call(node) {
                let mut children = Vec::new();
                if !flatten_markup_children(body, marks, &mut children) {
                    return false;
                }
                out.push(AstInline::Link { href, children });
                return true;
            }
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
    fn link_inside_running_text_becomes_an_inline_link() {
        let doc = parse("See #link(\"https://typst.app\")[the docs] for more.");
        let AstBlock::Paragraph { children } = &doc.content[0] else {
            panic!("expected a paragraph, got {:?}", doc.content[0]);
        };
        assert!(
            children.contains(&AstInline::Link {
                href: "https://typst.app".into(),
                children: vec![AstInline::Text { text: "the docs".into(), marks: vec![] }],
            }),
            "{children:?}"
        );
    }

    #[test]
    fn standalone_link_paragraph_is_not_treated_as_an_opaque_block_call() {
        // A lone FuncCall filling a whole paragraph is normally the
        // "SingleCall" opaque-block special case (see
        // standalone_call_becomes_a_block_typst_call) - link must be
        // excluded from that so it stays a real (non-opaque) inline link.
        let doc = parse("#link(\"https://typst.app\")[Typst]");
        assert_eq!(
            doc.content,
            vec![AstBlock::Paragraph {
                children: vec![AstInline::Link {
                    href: "https://typst.app".into(),
                    children: vec![AstInline::Text { text: "Typst".into(), marks: vec![] }],
                }],
            }]
        );
    }

    #[test]
    fn bold_text_inside_a_link_keeps_the_strong_mark() {
        let doc = parse("#link(\"https://typst.app\")[*Typst*]");
        assert_eq!(
            doc.content,
            vec![AstBlock::Paragraph {
                children: vec![AstInline::Link {
                    href: "https://typst.app".into(),
                    children: vec![AstInline::Text {
                        text: "Typst".into(),
                        marks: vec!["strong".into()],
                    }],
                }],
            }]
        );
    }

    #[test]
    fn a_link_nested_inside_bold_carries_the_strong_mark_on_its_text() {
        let doc = parse("*#link(\"https://typst.app\")[Typst]*");
        assert_eq!(
            doc.content,
            vec![AstBlock::Paragraph {
                children: vec![AstInline::Link {
                    href: "https://typst.app".into(),
                    children: vec![AstInline::Text {
                        text: "Typst".into(),
                        marks: vec!["strong".into()],
                    }],
                }],
            }]
        );
    }

    #[test]
    fn link_with_unsupported_body_content_degrades_the_whole_paragraph() {
        // A link's body is recursively parsed through the same subset
        // parser as any other markup (see bold_text_inside_a_link_...) - so
        // content outside the subset inside it (math, here) must propagate
        // failure up and degrade the whole containing paragraph verbatim,
        // same as any other unrecognized construct.
        let doc = parse("#link(\"https://typst.app\")[$x^2$]");
        assert_eq!(
            doc.content,
            vec![AstBlock::UnsupportedBlock { raw: "#link(\"https://typst.app\")[$x^2$]".into() }]
        );
    }

    #[test]
    fn link_call_without_a_content_body_falls_back_to_an_opaque_call() {
        // `#link("url")` alone (no `[body]`) doesn't match the recognized
        // two-positional-arg shape, so it stays an opaque typst_call, same
        // as any other call outside the MVP subset.
        let doc = parse("#link(\"https://typst.app\")");
        assert_eq!(
            doc.content,
            vec![AstBlock::TypstCall {
                name: "link".into(),
                raw: "#link(\"https://typst.app\")".into(),
            }]
        );
    }

    #[test]
    fn escaped_brackets_round_trip_as_literal_bracket_characters() {
        // Confirms `\[`/`\]` are ordinary Escape nodes like `\*`/`\_` (not a
        // parse error) — each produces its own AstInline::Text leaf here
        // (Escape and Text are distinct CST node kinds, only coalesced into
        // one PM text node later by typstAst.ts's run-merging), but the
        // premise this test exists to check is that they parse to *literal*
        // "["/"]" characters at all — the basis for escaping `[`/`]` in a
        // link's body text on the way out (src/typstAst.ts's
        // escapeTypstText), since that's the first place this codebase
        // embeds arbitrary text inside a Typst content-block `[...]`
        // delimiter pair (plan.md M9).
        let doc = parse("a \\[b\\] c");
        let AstBlock::Paragraph { children } = &doc.content[0] else {
            panic!("expected a paragraph, got {:?}", doc.content[0]);
        };
        let text: String = children
            .iter()
            .map(|c| match c {
                AstInline::Text { text, .. } => text.as_str(),
                _ => panic!("expected only Text children, got {c:?}"),
            })
            .collect();
        assert_eq!(text, "a [b] c");
    }

    #[test]
    fn table_with_integer_columns_becomes_a_structured_table() {
        let doc = parse("#table(columns: 2, [A], [B], [C], [D])");
        assert_eq!(
            doc.content,
            vec![AstBlock::Table {
                columns_raw: "2".into(),
                column_count: 2,
                cells: vec![
                    vec![AstBlock::Paragraph {
                        children: vec![AstInline::Text { text: "A".into(), marks: vec![] }]
                    }],
                    vec![AstBlock::Paragraph {
                        children: vec![AstInline::Text { text: "B".into(), marks: vec![] }]
                    }],
                    vec![AstBlock::Paragraph {
                        children: vec![AstInline::Text { text: "C".into(), marks: vec![] }]
                    }],
                    vec![AstBlock::Paragraph {
                        children: vec![AstInline::Text { text: "D".into(), marks: vec![] }]
                    }],
                ],
            }]
        );
    }

    #[test]
    fn table_with_array_columns_preserves_the_raw_width_spec() {
        let doc = parse("#table(columns: (1fr, 2fr), [A], [B])");
        let AstBlock::Table { columns_raw, column_count, .. } = &doc.content[0] else {
            panic!("expected a table, got {:?}", doc.content[0]);
        };
        assert_eq!(columns_raw, "(1fr, 2fr)");
        assert_eq!(*column_count, 2);
    }

    #[test]
    fn a_table_cell_can_contain_marked_up_text() {
        let doc = parse("#table(columns: 1, [*bold* and _italic_])");
        let AstBlock::Table { cells, .. } = &doc.content[0] else {
            panic!("expected a table, got {:?}", doc.content[0]);
        };
        assert_eq!(
            cells[0],
            vec![AstBlock::Paragraph {
                children: vec![
                    AstInline::Text { text: "bold".into(), marks: vec!["strong".into()] },
                    AstInline::Text { text: " ".into(), marks: vec![] },
                    AstInline::Text { text: "and".into(), marks: vec![] },
                    AstInline::Text { text: " ".into(), marks: vec![] },
                    AstInline::Text { text: "italic".into(), marks: vec!["em".into()] },
                ],
            }]
        );
    }

    #[test]
    fn a_ragged_cell_count_falls_back_to_an_opaque_call() {
        // 3 cells isn't a multiple of 2 columns - not a well-formed grid.
        let doc = parse("#table(columns: 2, [A], [B], [C])");
        assert_eq!(
            doc.content,
            vec![AstBlock::TypstCall {
                name: "table".into(),
                raw: "#table(columns: 2, [A], [B], [C])".into(),
            }]
        );
    }

    #[test]
    fn a_table_with_styling_arguments_falls_back_to_an_opaque_call() {
        // `stroke:`/`fill:`/etc. are explicitly out of the MVP subset
        // (plan.md M10: "no ... styling args in MVP").
        let doc = parse("#table(columns: 2, stroke: red, [A], [B])");
        assert_eq!(
            doc.content,
            vec![AstBlock::TypstCall {
                name: "table".into(),
                raw: "#table(columns: 2, stroke: red, [A], [B])".into(),
            }]
        );
    }

    #[test]
    fn a_table_with_a_non_content_block_cell_falls_back_to_an_opaque_call() {
        // `#table.cell(...)` (rowspan/colspan) isn't a bare content block.
        let doc = parse("#table(columns: 2, [A], table.cell(colspan: 2)[B])");
        assert!(matches!(doc.content[0], AstBlock::TypstCall { .. }));
    }

    #[test]
    fn table_compiles_successfully_and_the_call_shape_matches_a_realistic_table() {
        // Confirms the recognized shape isn't a narrower toy grammar than
        // what a real Typst document actually contains - multiple rows, a
        // header-looking first row (bold text, no distinct node type - see
        // AstBlock::Table's doc comment), mixed inline marks in a cell.
        let doc = parse(
            "#table(columns: 3, [*Name*], [*Age*], [*City*], [Alice], [30], [NYC], [Bob], [25], [LA])",
        );
        let AstBlock::Table { column_count, cells, .. } = &doc.content[0] else {
            panic!("expected a table, got {:?}", doc.content[0]);
        };
        assert_eq!(*column_count, 3);
        assert_eq!(cells.len(), 9);
    }

    #[test]
    fn a_table_can_be_a_list_items_primary_content() {
        // Exercises convert_markup's table recognition being reachable
        // through the *same* recursive path list item bodies already use
        // (is_root=false), not just the document root — mirrors why
        // schema.ts's list_item content spec was extended to include table.
        let doc = parse("- #table(columns: 2, [A], [B])\n- Plain item\n");
        let AstBlock::BulletList { items } = &doc.content[0] else {
            panic!("expected a bullet list, got {:?}", doc.content[0]);
        };
        assert_eq!(items.len(), 2);
        assert!(matches!(items[0][0], AstBlock::Table { column_count: 2, .. }));
        assert_eq!(
            items[1],
            vec![AstBlock::Paragraph {
                children: vec![AstInline::Text { text: "Plain item".into(), marks: vec![] }]
            }]
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
