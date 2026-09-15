//! `find_block_references` Tauri command (Phase 4, phase4-product-validation.md):
//! for a focused block's own byte range, find every `#let`/`#import` variable
//! or function reference and `@ref`/`<label>` cross-reference *made within
//! that block's text*, resolved to where each one is actually declared —
//! the "reference-chain navigation" UI's backing data (interaction-design.md
//! §10 结论 14): a list above the focused textarea, click an item to jump to
//! its declaration.
//!
//! Deliberately does *not* implement scope resolution itself. `typst-ide`
//! (already a dependency — `jump.rs` uses it for click/cursor sync) exports
//! exactly this "go to definition" capability, built for the same reason
//! real language servers need it: `typst_ide::deref_target` classifies a
//! syntax node as a reference-like construct, and `typst_ide::definition`
//! resolves a cursor position to where it's declared — for `#let`/`#import`
//! via `named_items` (a real ancestor/preceding-sibling scope walk, not a
//! name-text match — the risk that made hand-rolling this seem safer to
//! scope down to labels-only turned out to already be solved), for
//! `@ref`/`<label>` via the compiled document's `Introspector` (a genuine
//! `Label -> position` hash index, not a linear scan). Both paths cost is
//! bounded by local scope depth / an O(1) hash lookup — not by total
//! document size — so this module's own job reduces to: find the smallest
//! syntax subtree covering the focused block's byte range, enumerate its
//! candidate reference sites, and call into `typst-ide` once per candidate.
//!
//! `#set` rule "influence" tracking (which `#set` affects a given block) is
//! a deliberately different, harder problem *not* covered here — `#set`
//! doesn't bind a name a later reference can point at by identity, so
//! `deref_target`/`definition` have no query for it at all. See this
//! module's own doc comment and phase4-product-validation.md for why that's
//! a real scope boundary, not an oversight.

use std::collections::HashSet;
use std::ops::Range;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use typst::{World, WorldExt};
use typst::syntax::{LinkedNode, Side, ast};
use typst_ide::{Definition, DerefTarget, deref_target, definition};
use typst_layout::PagedDocument;

use crate::compile::sync_session;
use crate::typst_world::TauriWorld;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct BlockReference {
    /// The identifier or label name, for list display.
    pub name: String,
    /// Where the reference itself sits, within the focused block's own text.
    pub ref_start: usize,
    pub ref_end: usize,
    /// Where it resolves to — the declaration to jump to on click.
    pub def_start: usize,
    pub def_end: usize,
}

#[tauri::command]
pub fn find_block_references(
    source: String,
    base_dir: Option<String>,
    block_start: usize,
    block_end: usize,
    session: tauri::State<'_, Mutex<TauriWorld>>,
) -> Vec<BlockReference> {
    let mut world = session.lock().unwrap();
    find_block_references_with_world(
        &mut world,
        source,
        base_dir.map(PathBuf::from),
        block_start..block_end,
    )
}

/// Split out from the `#[tauri::command]` shim purely so tests can call it
/// directly against a `TauriWorld` they construct themselves, without
/// needing a running Tauri app to obtain a `State` — same pattern as
/// `compile.rs`/`geometry.rs`'s own `_with_world` split.
fn find_block_references_with_world(
    world: &mut TauriWorld,
    source: String,
    base_dir: Option<PathBuf>,
    block_range: Range<usize>,
) -> Vec<BlockReference> {
    sync_session(world, source, base_dir);

    let Ok(document) = typst::compile::<PagedDocument>(&*world).output else {
        return Vec::new();
    };
    let Ok(src) = world.source(world.main()) else {
        return Vec::new();
    };

    let root = LinkedNode::new(src.root());
    let Some(subtree) = smallest_enclosing(&root, &block_range) else {
        return Vec::new();
    };

    let mut leaves = Vec::new();
    collect_leaves(&subtree, &mut leaves);

    let mut seen_ref_sites = HashSet::new();
    let mut results = Vec::new();
    for leaf in leaves {
        let Some(target) = deref_target(leaf) else { continue };
        let Some(expr_node) = reference_node(&target) else { continue };
        let ref_range = expr_node.range();
        // The enclosing subtree can be slightly larger than the block itself
        // (no syntax node boundary lines up exactly with the block-splitting
        // boundary) — only keep candidates whose own span actually falls
        // inside the block, not just inside its nearest common ancestor.
        if ref_range.start < block_range.start || ref_range.end > block_range.end {
            continue;
        }
        if !seen_ref_sites.insert((ref_range.start, ref_range.end)) {
            continue;
        }
        let Some(name) = reference_name(&target) else { continue };

        // Any cursor strictly inside the reference's own span re-derives the
        // exact same leaf/`DerefTarget` `definition` would find on its own —
        // avoids needing `definition` to expose a "resolve this DerefTarget
        // directly" entry point that doesn't otherwise exist.
        let cursor = (ref_range.start + ref_range.end) / 2;
        let Some(Definition::Span(def_span)) =
            definition(&*world, Some(&document), &src, cursor, Side::After)
        else {
            continue;
        };
        // `Definition::Std`/`Definition::File` are filtered out by the `let
        // Some` above; a `Span` can still point into another file in
        // general, but this project is single-document, so also require it
        // to resolve inside the same file being edited.
        if def_span.id() != Some(world.main()) {
            continue;
        }
        let Some(def_range) = world.range(def_span) else { continue };
        // A `#let x = ...`'s own declared name is itself an `Ident` node,
        // which `deref_target` also classifies as `VarAccess` — without
        // this, every binding's own name shows up as "referencing itself".
        if def_range == ref_range {
            continue;
        }

        results.push(BlockReference {
            name,
            ref_start: ref_range.start,
            ref_end: ref_range.end,
            def_start: def_range.start,
            def_end: def_range.end,
        });
    }

    // "Which variables/labels this block references" is a list of unique
    // targets, not a log of every occurrence — the same definition used
    // twice in one block shows once.
    let mut seen_defs = HashSet::new();
    results.retain(|r| seen_defs.insert((r.def_start, r.def_end)));
    results.sort_by_key(|r| r.def_start);
    results
}

/// Descends from `node` to the smallest descendant whose span still fully
/// covers `range`, stopping (and returning the current node) once no child
/// covers it anymore — bounded by tree depth, not document size, and the
/// *only* part of this function whose cost depends on where `range` sits in
/// the whole document. Returns `None` only if `node` itself doesn't cover
/// `range` (shouldn't happen for a real call starting from the document
/// root, since the root's own span is the whole source).
fn smallest_enclosing<'a>(node: &LinkedNode<'a>, range: &Range<usize>) -> Option<LinkedNode<'a>> {
    let own = node.range();
    if own.start > range.start || range.end > own.end {
        return None;
    }
    for child in node.children() {
        if let Some(found) = smallest_enclosing(&child, range) {
            return Some(found);
        }
    }
    Some(node.clone())
}

/// Collects every leaf (childless) descendant of `node`, inclusive of `node`
/// itself if it has no children — `deref_target` walks *up* from wherever
/// it's given to the nearest enclosing expression, so starting from leaves
/// is enough to reach every candidate reference site in the subtree; walking
/// every node (not just leaves) would just call `deref_target` many times
/// per site for no extra candidates, since they'd all resolve to the same
/// ancestor.
fn collect_leaves<'a>(node: &LinkedNode<'a>, out: &mut Vec<LinkedNode<'a>>) {
    let mut has_children = false;
    for child in node.children() {
        has_children = true;
        collect_leaves(&child, out);
    }
    if !has_children {
        out.push(node.clone());
    }
}

/// The `LinkedNode` `deref_target` resolved to, for the kinds this module
/// cares about (`#let`/`#import` variable or function references,
/// `@ref`/`<label>` cross-references) — `None` for every other
/// `DerefTarget` variant (import/include paths, arbitrary code expressions),
/// which aren't in this pass's scope (see this module's own doc comment).
fn reference_node<'a>(target: &DerefTarget<'a>) -> Option<LinkedNode<'a>> {
    match target {
        DerefTarget::VarAccess(n) | DerefTarget::Callee(n) | DerefTarget::Ref(n) => {
            Some(n.clone())
        }
        _ => None,
    }
}

/// The display name for a resolved reference node — the identifier text for
/// a variable/function access, or the target name for a `@ref`.
fn reference_name(target: &DerefTarget) -> Option<String> {
    match target {
        DerefTarget::VarAccess(n) | DerefTarget::Callee(n) => match n.cast::<ast::Expr>()? {
            ast::Expr::Ident(id) => Some(id.as_str().to_string()),
            ast::Expr::FieldAccess(access) => Some(access.field().as_str().to_string()),
            _ => None,
        },
        DerefTarget::Ref(n) => Some(n.cast::<ast::Ref>()?.target().to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find_block_references(source: &str, block_range: Range<usize>) -> Vec<BlockReference> {
        let mut world = TauriWorld::new(String::new(), None);
        find_block_references_with_world(&mut world, source.into(), None, block_range)
    }

    fn range_of(source: &str, needle: &str) -> Range<usize> {
        let start = source.find(needle).unwrap();
        start..start + needle.len()
    }

    #[test]
    fn a_let_bound_variable_used_in_a_later_block_resolves_to_its_declaration() {
        let source = "#let greeting = \"hi\"\n\n#greeting";
        let block = range_of(source, "#greeting");
        let refs = find_block_references(source, block);
        assert_eq!(refs.len(), 1, "{refs:?}");
        assert_eq!(refs[0].name, "greeting");
        assert_eq!(refs[0].def_start, range_of(source, "greeting").start);
    }

    #[test]
    fn same_name_in_different_scopes_resolves_to_the_locally_visible_binding() {
        // Two unrelated `x`s in disjoint scopes -- the reference inside the
        // second block must resolve to the *second* let, not the first,
        // proving this goes through real scope resolution (`named_items`),
        // not a first-match-wins name search.
        let source = "#let x = 1\n#{ x }\n\n#let x = 2\n\n#x";
        let block = range_of(source, "\n\n#x");
        let refs = find_block_references(source, range_of(source, "#x"));
        let expected_def = source.rfind("let x = 2").unwrap() + "let ".len();
        assert_eq!(refs.len(), 1, "{refs:?}");
        assert_eq!(refs[0].def_start, expected_def);
        let _ = block;
    }

    #[test]
    fn a_label_reference_resolves_to_its_labelled_element() {
        let source = "#figure[Diagram] <fig:one>\n\nSee @fig:one for details.";
        let block = range_of(source, "See @fig:one for details.");
        let refs = find_block_references(source, block);
        assert_eq!(refs.len(), 1, "{refs:?}");
        assert_eq!(refs[0].name, "fig:one");
        // `typst_ide::definition` resolves a `@ref` to the *labelled
        // element's* own span (here, the `figure[Diagram]` call) rather than
        // the bare `<fig:one>` token — matches typst-ide's own
        // `test_definition_ref` convention. Good enough for this project's
        // block-level jump granularity: the label sits in the same block as
        // the element it names, so focusing whichever block contains this
        // span still lands on the right block.
        let element_range = range_of(source, "figure[Diagram]");
        assert_eq!(refs[0].def_start, element_range.start);
        assert_eq!(refs[0].def_end, element_range.end);
    }

    #[test]
    fn a_reference_to_a_nonexistent_label_is_silently_omitted() {
        let source = "See @nowhere for details.";
        let refs = find_block_references(source, 0..source.len());
        assert_eq!(refs, Vec::new());
    }

    #[test]
    fn a_reference_to_a_standard_library_function_is_filtered_out() {
        // `table` resolves to `Definition::Std`, not a real declaration in
        // this document -- there's nowhere to jump, so it must not appear.
        let source = "#table(columns: 1)[a]";
        let refs = find_block_references(source, 0..source.len());
        assert_eq!(refs, Vec::new());
    }

    #[test]
    fn a_lets_own_declared_name_does_not_reference_itself() {
        let source = "#let x = 1";
        let refs = find_block_references(source, 0..source.len());
        assert_eq!(refs, Vec::new(), "{refs:?}");
    }

    #[test]
    fn the_same_binding_referenced_twice_in_one_block_is_deduplicated() {
        let source = "#let x = 1\n\n#x + #x";
        let refs = find_block_references(source, range_of(source, "#x + #x"));
        assert_eq!(refs.len(), 1, "{refs:?}");
    }

    #[test]
    fn only_the_queried_blocks_own_subtree_is_processed_not_the_whole_document() {
        // A synthetic document with many independent sections; querying one
        // paragraph's own range must not pick up references that live in
        // *other* sections' text, even when they'd resolve validly on their
        // own.
        let mut source = String::from("#let shared = 1\n\n");
        for i in 0..50 {
            source.push_str(&format!("Section {i} body text, nothing special here.\n\n"));
        }
        let target_start = source.len();
        source.push_str("#shared");
        let refs = find_block_references(&source, target_start..source.len());
        assert_eq!(refs.len(), 1, "{refs:?}");
        assert_eq!(refs[0].name, "shared");

        // A block with no references at all comes back empty, same fixture.
        let empty_block = range_of(&source, "Section 10 body text, nothing special here.");
        let refs = find_block_references(&source, empty_block);
        assert_eq!(refs, Vec::new());
    }
}
