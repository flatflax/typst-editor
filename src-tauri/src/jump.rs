//! Bidirectional position mapping between Typst source and the rendered
//! preview, via `typst-ide` (see plan.md M1). Scoped to page 1: MVP
//! documents are a few paragraphs and expected to fit on a single page, so
//! multi-page offset math is not implemented — a non-blocking enhancement
//! degrading gracefully, not something the rest of the app depends on.

use serde::Serialize;
use typst::World;
use typst::layout::{Abs, Point};
use typst::syntax::Source;
use typst_ide::{Jump, jump_from_click_in_frame, jump_from_cursor as ide_jump_from_cursor};
use typst_layout::PagedDocument;

use crate::typst_world::TauriWorld;

#[derive(Serialize)]
pub struct CursorTarget {
    page: usize,
    x_pt: f64,
    y_pt: f64,
}

/// Click-to-source: given a click position (in pt) on the first rendered
/// page, return the byte offset in the Typst source it corresponds to.
#[tauri::command]
pub fn jump_from_click(source: String, x_pt: f64, y_pt: f64) -> Option<usize> {
    let world = TauriWorld::new(source);
    let document: PagedDocument = typst::compile(&world).output.ok()?;
    let page = document.pages().first()?;
    let click = Point::new(Abs::pt(x_pt), Abs::pt(y_pt));
    match jump_from_click_in_frame(&world, &document, &page.frame, click)? {
        Jump::File(id, offset) if id == world.main() => Some(offset),
        _ => None,
    }
}

/// Source-to-render: given a byte offset (cursor position) in the Typst
/// source, return the page + point it renders to, for scroll/highlight
/// sync in the preview pane.
#[tauri::command]
pub fn jump_from_cursor(source: String, cursor: usize) -> Vec<CursorTarget> {
    let world = TauriWorld::new(source.clone());
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

    #[test]
    fn cursor_in_heading_maps_to_a_render_position() {
        let targets = jump_from_cursor("= Hello".into(), 3);
        assert!(!targets.is_empty());
        assert_eq!(targets[0].page, 1);
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
}
