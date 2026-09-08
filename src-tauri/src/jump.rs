//! Bidirectional position mapping between Typst source and the rendered
//! preview, via `typst-ide` (see plan.md M1).

use std::path::PathBuf;

use serde::Serialize;
use typst::World;
use typst::layout::{Abs, Point};
use typst::syntax::Source;
use typst_ide::{Jump, jump_from_click_in_frame, jump_from_cursor as ide_jump_from_cursor};
use typst_layout::PagedDocument;

use crate::geometry;
use crate::typst_world::TauriWorld;

#[derive(Serialize)]
pub struct CursorTarget {
    page: usize,
    x_pt: f64,
    y_pt: f64,
}

/// Resolves a Y coordinate in `svg_merged`'s merged coordinate space (see
/// `geometry::page_offsets_pt`) to a page index (0-based) and that page's own
/// local Y — the input `jump_from_click_in_frame` actually needs, since it
/// operates on one page's `Frame` at a time. A `y_pt` landing in the gap
/// between two pages snaps to the top of the following page (matching how a
/// click just past a page's bottom edge should behave); a `y_pt` beyond the
/// whole document clamps onto the last page rather than returning nothing —
/// callers synthesizing a click from arrow-key navigation (M20) rely on this
/// to reach the first/last line via a target that overshoots slightly rather
/// than needing to know the exact document height themselves.
fn page_at_merged_y(document: &PagedDocument, offsets: &[f64], y_pt: f64) -> Option<(usize, f64)> {
    let pages = document.pages();
    let last = pages.len().checked_sub(1)?;
    for (i, page) in pages.iter().enumerate() {
        let start = offsets[i];
        let height = page.frame.size().y.to_pt();
        if y_pt < start + height || i == last {
            return Some((i, (y_pt - start).clamp(0.0, height.max(0.0))));
        }
    }
    None
}

/// Click-to-source: given a click position (in pt) in `svg_merged`'s merged,
/// multi-page coordinate space, return the byte offset in the Typst source
/// it corresponds to. `base_dir` (plan.md M11) must match whatever
/// `compile_typst` was given for this same source, or a document containing
/// an `#image(...)` will fail to compile here and this degrades to `None`
/// (same "no target" result as any other compile failure — see
/// `jump_from_cursor` below).
#[tauri::command]
pub fn jump_from_click(source: String, x_pt: f64, y_pt: f64, base_dir: Option<String>) -> Option<usize> {
    let world = TauriWorld::new(source, base_dir.map(PathBuf::from));
    let document: PagedDocument = typst::compile(&world).output.ok()?;
    let offsets = geometry::page_offsets_pt(&document);
    let (page_index, local_y_pt) = page_at_merged_y(&document, &offsets, y_pt)?;
    let page = document.pages().get(page_index)?;
    let click = Point::new(Abs::pt(x_pt), Abs::pt(local_y_pt));
    match jump_from_click_in_frame(&world, &document, &page.frame, click)? {
        Jump::File(id, offset) if id == world.main() => Some(offset),
        _ => None,
    }
}

/// Source-to-render: given a byte offset (cursor position) in the Typst
/// source, return the page + point it renders to, for scroll/highlight
/// sync in the preview pane. See `jump_from_click` on `base_dir`.
#[tauri::command]
pub fn jump_from_cursor(source: String, cursor: usize, base_dir: Option<String>) -> Vec<CursorTarget> {
    let world = TauriWorld::new(source.clone(), base_dir.map(PathBuf::from));
    let Ok(document) = typst::compile::<PagedDocument>(&world).output else {
        return Vec::new();
    };

    let src = Source::detached(source);
    ide_jump_from_cursor(&document, &src, cursor)
        .into_iter()
        .map(|pos| CursorTarget {
            page: pos.page.get(),
            x_pt: pos.point.x.to_pt(),
            y_pt: pos.point.y.to_pt(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shadow the outer 3-arg commands so existing tests (none of which care
    // about image-path resolution, plan.md M11) don't need `, None` added
    // individually — same approach as compile.rs's test module.
    fn jump_from_click(source: String, x_pt: f64, y_pt: f64) -> Option<usize> {
        super::jump_from_click(source, x_pt, y_pt, None)
    }
    fn jump_from_cursor(source: String, cursor: usize) -> Vec<CursorTarget> {
        super::jump_from_cursor(source, cursor, None)
    }

    #[test]
    fn cursor_in_heading_maps_to_a_render_position() {
        let targets = jump_from_cursor("= Hello".into(), 3);
        assert!(!targets.is_empty());
        assert_eq!(targets[0].page, 1);
    }

    /// A document mixing every MVP-subset construct plus several
    /// out-of-subset ones (comments, `#set` rules, labels, term lists, raw
    /// blocks) — exercises jump sync against realistic, varied content
    /// rather than single-line fixtures.
    const MIXED_DOCUMENT: &str = "\
#set text(font: \"New Computer Modern\", size: 11pt)
// a comment

= Heading <a-label>

Some paragraph text with *bold* and _italic_.

- 苹果
  - 子项目
+ 第一步

/ Term: a definition.

`inline code`

```rust
fn main() {}
```
";

    /// `jump_from_cursor` (via `typst-ide`) only anchors to `Text`/`MathText`
    /// syntax leaves. Comments and `#set` rules are compiler directives with
    /// zero visual output, so there is nothing on the page to point to —
    /// this is an inherent property of source-level (non-WYSIWYG) sync, not
    /// a bug: everything that actually renders (headings, nested/ordered
    /// lists, term lists, inline code, fenced code blocks, CJK text) maps
    /// correctly.
    #[test]
    fn cursor_sync_covers_rendered_content_but_not_comments_or_directives() {
        let renders_to_a_position = [
            "Heading", "bold", "苹果", "子项目", "第一步", "Term", "inline code", "fn main",
        ];
        for needle in renders_to_a_position {
            let offset = MIXED_DOCUMENT.find(needle).unwrap() + 1;
            let targets = jump_from_cursor(MIXED_DOCUMENT.into(), offset);
            assert!(!targets.is_empty(), "expected a render position for {needle:?}");
        }

        let has_no_visual_output = ["a comment", "#set text"];
        for needle in has_no_visual_output {
            let offset = MIXED_DOCUMENT.find(needle).unwrap() + 1;
            let targets = jump_from_cursor(MIXED_DOCUMENT.into(), offset);
            assert!(targets.is_empty(), "expected no render position for {needle:?}");
        }
    }

    #[test]
    fn click_round_trips_close_to_the_original_offset_for_rendered_content() {
        for needle in ["Heading", "bold", "苹果", "子项目", "第一步", "Term", "fn main"] {
            let offset = MIXED_DOCUMENT.find(needle).unwrap() + 1;
            let targets = jump_from_cursor(MIXED_DOCUMENT.into(), offset);
            let target = targets.first().unwrap_or_else(|| panic!("no target for {needle:?}"));

            // `target.y_pt` is the exact glyph baseline; clicking precisely
            // on that boundary is float-rounding-sensitive in the frame
            // hit-test (`pos.y - size + size` isn't bit-exact to `pos.y`).
            // A real mouse click always lands inside the glyph's visible
            // body, a bit above the baseline — simulate that instead of the
            // mathematical boundary point.
            let clicked = jump_from_click(MIXED_DOCUMENT.into(), target.x_pt, target.y_pt - 1.0);
            let clicked = clicked.unwrap_or_else(|| panic!("click found nothing for {needle:?}"));
            assert!(
                clicked.abs_diff(offset) <= 4,
                "{needle:?}: click round-tripped to {clicked}, expected near {offset}"
            );
        }
    }

    #[test]
    fn click_in_heading_maps_back_to_source() {
        let targets = jump_from_cursor("= Hello".into(), 3);
        let target = &targets[0];
        let offset = jump_from_click(
            "= Hello".into(),
            target.x_pt + 1.0,
            target.y_pt,
        );
        assert!(offset.is_some());
    }

    /// `jump_from_click` used to hardcode `document.pages().first()` (M1-era
    /// scope: MVP documents were expected to fit on one page) — a click on
    /// `svg_merged`'s merged coordinate space beyond page 1's height would
    /// silently hit-test against page 1's own content, at best returning a
    /// wrong offset and at worst `None`. M20 needs the whole rendered
    /// document to be clickable, not just its first page.
    #[test]
    fn click_beyond_page_one_resolves_against_the_page_it_actually_lands_on() {
        let source = "#set page(height: 60pt, margin: 5pt)\n\
                       First page line.\n#pagebreak()\nSecond page line.";
        let world = TauriWorld::new(source.into(), None);
        let document: PagedDocument = typst::compile(&world).output.expect("fixture must compile");
        assert_eq!(document.pages().len(), 2, "fixture must actually paginate");
        let page_one_height_pt = document.pages()[0].frame.size().y.to_pt();

        let targets = jump_from_cursor(source.into(), source.find("Second page line").unwrap() + 1);
        let target = targets.iter().find(|t| t.page == 2).expect("must resolve onto page 2");

        // Same "click a bit above the exact baseline" adjustment as
        // `click_round_trips_close_to_the_original_offset_for_rendered_content`.
        let merged_y_pt = page_one_height_pt + geometry::PAGE_GAP_PT + target.y_pt - 1.0;
        let clicked = jump_from_click(source.into(), target.x_pt, merged_y_pt);
        let clicked = clicked.expect("click on page 2 content must resolve to something");

        let expected = source.find("Second page line").unwrap();
        assert!(
            clicked.abs_diff(expected) <= 4,
            "click on page 2 resolved to byte {clicked}, expected near {expected} (\"Second page line\")"
        );
    }
}
