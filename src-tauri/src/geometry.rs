//! M14A (plan.md): can `typst::layout`/`typst-ide`'s `Frame` data yield
//! stable per-range rendered geometry, or does M15 need deeper Rust-side
//! `Frame`-walking (or fall back to coarse per-block boxes only)? Prototype
//! for a single question: given a source byte range `[a, b)`, what page(s)
//! does it render on, and what are its line-level bounding boxes?
//!
//! Approach: walk every page's `Frame` tree, and for each rendered item
//! whose span overlaps the target range, record a "hit" in page-absolute
//! coordinates — exactly the same span-matching `typst-ide`'s
//! `jump_from_click`/`jump_from_cursor` (jump.rs) already do for a single
//! point, generalized to a range and to collecting geometry instead of just
//! a byte offset. See phase3-single-view.md for the recorded findings and
//! their consequence for M15.

use std::ops::Range;

use typst::WorldExt;
use typst::layout::{Frame, FrameItem, Point};
use typst::syntax::Span;
use typst::text::Glyph;
use typst_layout::PagedDocument;

/// One reconstructed visual line (for text) or one whole shape/image box,
/// in page-absolute point coordinates, `y_top_pt` measured from the page's
/// top-left as Typst frames do.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RangeBox {
    pub page: usize,
    pub x_pt: f64,
    pub y_top_pt: f64,
    pub width_pt: f64,
    pub height_pt: f64,
    /// Distance from `y_top_pt` down to the text baseline — `Some` only for
    /// text-derived boxes. Images/shapes have no baseline of their own.
    pub baseline_from_top_pt: Option<f64>,
}

/// A single glyph or shape/image whose span overlapped the target range,
/// before line-clustering. Kept minimal — just what `cluster` needs.
struct Hit {
    page: usize,
    x_pt: f64,
    y_top_pt: f64,
    width_pt: f64,
    height_pt: f64,
    baseline_from_top_pt: Option<f64>,
}

/// For every rendered occurrence of `range` in `document`, return one
/// [`RangeBox`] per reconstructed visual line (text) or per shape/image.
/// Multiple boxes on the same page, or on different pages, both fall out
/// naturally from the same collection pass — no special-casing needed for
/// "this range wraps onto a second line" vs. "this range is a footnote body
/// rendered elsewhere on the page" vs. "this range crosses a page break":
/// each is just another non-adjacent hit.
pub(crate) fn geometry_for_range(
    world: &dyn typst::World,
    document: &PagedDocument,
    range: Range<usize>,
) -> Vec<RangeBox> {
    let mut hits = Vec::new();
    for (index, page) in document.pages().iter().enumerate() {
        collect_hits(world, &page.frame, Point::zero(), index + 1, &range, &mut hits);
    }
    cluster_into_boxes(hits)
}

/// Recursively walks `frame`, accumulating each item's position relative to
/// the page origin. `origin` is only translated through nested `Group`s, not
/// rotated/scaled by `GroupItem::transform` — a known simplification (see
/// phase3-single-view.md) that holds for ordinary flow content (paragraphs,
/// headings, lists, images) but not for content under `#rotate`/`#scale`.
fn collect_hits(
    world: &dyn typst::World,
    frame: &Frame,
    origin: Point,
    page: usize,
    range: &Range<usize>,
    hits: &mut Vec<Hit>,
) {
    for &(pos, ref item) in frame.items() {
        let abs_pos = origin + pos;
        match item {
            FrameItem::Group(group) => {
                collect_hits(world, &group.frame, abs_pos, page, range, hits);
            }
            FrameItem::Text(text) => {
                let mut x = abs_pos.x;
                for glyph in &text.glyphs {
                    let width = glyph.x_advance.at(text.size);
                    if glyph_source_offset(world, glyph).is_some_and(|o| range.contains(&o)) {
                        // Typst's `Frame` doesn't expose real font-metrics
                        // ascent/descent for a glyph run, only the font
                        // size used to lay it out — the same approximation
                        // typst-ide's own click hit-testing uses (jump.rs:
                        // `pos.y - text.size` .. `pos.y`).
                        let ascent = text.size.to_pt();
                        let descent = ascent * 0.25;
                        hits.push(Hit {
                            page,
                            x_pt: x.to_pt(),
                            y_top_pt: abs_pos.y.to_pt() - ascent,
                            width_pt: width.to_pt(),
                            height_pt: ascent + descent,
                            baseline_from_top_pt: Some(ascent),
                        });
                    }
                    x += width;
                }
            }
            FrameItem::Image(_, size, span) => {
                if span_overlaps(world, *span, range) {
                    hits.push(Hit {
                        page,
                        x_pt: abs_pos.x.to_pt(),
                        y_top_pt: abs_pos.y.to_pt(),
                        width_pt: size.x.to_pt(),
                        height_pt: size.y.to_pt(),
                        baseline_from_top_pt: None,
                    });
                }
            }
            _ => {}
        }
    }
}

/// The exact source byte offset a glyph originated from: `typst-ide`'s own
/// click-to-source mapping (jump.rs) computes the same thing from
/// `glyph.span`'s `(Span, u16)` pair — the node's range plus a per-glyph
/// byte offset within it, giving per-character (not just per-node)
/// precision.
fn glyph_source_offset(world: &dyn typst::World, glyph: &Glyph) -> Option<usize> {
    let (span, span_offset) = glyph.span;
    let node_range = world.range(span)?;
    Some(node_range.start + usize::from(span_offset))
}

fn span_overlaps(world: &dyn typst::World, span: Span, range: &Range<usize>) -> bool {
    world.range(span).is_some_and(|r| r.start < range.end && r.end > range.start)
}

/// Merges text hits that share a page and baseline into one [`RangeBox`] per
/// visual line — Typst's `Frame` doesn't preserve a per-line sub-frame
/// boundary for ordinary text (short frames get inlined/flattened into
/// their parent, see phase3-single-view.md), so line reconstruction has to
/// happen here, by baseline, rather than by reading it off the tree
/// structure. Image/shape hits pass through unmerged (one hit is already
/// one whole box).
fn cluster_into_boxes(hits: Vec<Hit>) -> Vec<RangeBox> {
    let mut lines: Vec<RangeBox> = Vec::new();
    let mut others: Vec<RangeBox> = Vec::new();

    for hit in hits {
        if hit.baseline_from_top_pt.is_none() {
            others.push(RangeBox {
                page: hit.page,
                x_pt: hit.x_pt,
                y_top_pt: hit.y_top_pt,
                width_pt: hit.width_pt,
                height_pt: hit.height_pt,
                baseline_from_top_pt: None,
            });
            continue;
        }

        // Same page and baseline (to within float noise) extends the
        // current line's box instead of starting a new one.
        let baseline_pt = hit.y_top_pt + hit.baseline_from_top_pt.unwrap();
        let existing = lines.iter_mut().find(|line| {
            line.page == hit.page
                && (line.y_top_pt + line.baseline_from_top_pt.unwrap() - baseline_pt).abs() < 0.01
        });

        match existing {
            Some(line) => {
                let right_edge = (line.x_pt + line.width_pt).max(hit.x_pt + hit.width_pt);
                line.x_pt = line.x_pt.min(hit.x_pt);
                line.width_pt = right_edge - line.x_pt;
            }
            None => lines.push(RangeBox {
                page: hit.page,
                x_pt: hit.x_pt,
                y_top_pt: hit.y_top_pt,
                width_pt: hit.width_pt,
                height_pt: hit.height_pt,
                baseline_from_top_pt: hit.baseline_from_top_pt,
            }),
        }
    }

    lines.extend(others);
    lines.sort_by(|a, b| a.page.cmp(&b.page).then(a.y_top_pt.total_cmp(&b.y_top_pt)));
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    use crate::typst_world::TauriWorld;

    fn compile(source: &str) -> (TauriWorld, PagedDocument) {
        compile_with_base_dir(source, None)
    }

    fn compile_with_base_dir(source: &str, base_dir: Option<PathBuf>) -> (TauriWorld, PagedDocument) {
        let world = TauriWorld::new(source.into(), base_dir);
        let document = typst::compile::<PagedDocument>(&world).output.expect("fixture must compile");
        (world, document)
    }

    fn range_of(source: &str, needle: &str) -> Range<usize> {
        let start = source.find(needle).unwrap();
        start..start + needle.len()
    }

    #[test]
    fn a_single_line_paragraph_yields_one_line_box_on_page_one() {
        let source = "Hello world.";
        let (world, document) = compile(source);
        let boxes = geometry_for_range(&world, &document, range_of(source, "Hello"));

        assert_eq!(boxes.len(), 1, "{boxes:?}");
        assert_eq!(boxes[0].page, 1);
        assert!(boxes[0].width_pt > 0.0);
        assert!(boxes[0].baseline_from_top_pt.is_some());
    }

    /// The core M14A question: a range spanning a soft-wrapped paragraph
    /// (one PM block in the eventual M15 sense) must come back as multiple
    /// distinct line boxes, not one box (which would misalign an editable
    /// overlay against the second/third rendered line) or zero (which would
    /// mean wrapped content isn't locatable at all).
    #[test]
    fn a_wrapped_paragraph_yields_one_line_box_per_visual_line() {
        let source = "#set page(width: 100pt, height: auto, margin: 10pt)\n\
                       Alpha bravo charlie delta echo foxtrot golf hotel india \
                       juliett kilo lima mike november.";
        let (world, document) = compile(source);
        let full_text_start = source.find("Alpha").unwrap();
        let full_text_end = source.len();
        let boxes = geometry_for_range(&world, &document, full_text_start..full_text_end);

        assert!(boxes.len() >= 3, "expected several wrapped lines, got {boxes:?}");
        for pair in boxes.windows(2) {
            assert_eq!(pair[0].page, 1);
            assert!(
                pair[1].y_top_pt > pair[0].y_top_pt,
                "lines should be in top-to-bottom order: {boxes:?}"
            );
        }
    }

    #[test]
    fn a_heading_yields_a_line_box() {
        let source = "= A Heading\n\nBody text.";
        let (world, document) = compile(source);
        let boxes = geometry_for_range(&world, &document, range_of(source, "A Heading"));
        assert_eq!(boxes.len(), 1, "{boxes:?}");
    }

    /// Images don't carry a baseline, but their exact declared size is
    /// available directly from `FrameItem::Image`'s `Size` — no glyph-based
    /// approximation needed, unlike text.
    #[test]
    fn an_image_yields_an_exact_size_box_with_no_baseline() {
        let dir = std::env::temp_dir()
            .join(format!("typst-editor-test-geometry-img-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut bytes = Vec::new();
        image::RgbImage::new(20, 10)
            .write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();
        std::fs::write(dir.join("photo.png"), bytes).unwrap();

        let source = "#image(\"photo.png\", width: 40pt)";
        let (world, document) = compile_with_base_dir(source, Some(dir.clone()));
        let boxes = geometry_for_range(&world, &document, range_of(source, "#image"));

        assert_eq!(boxes.len(), 1, "{boxes:?}");
        assert!(boxes[0].baseline_from_top_pt.is_none());
        assert!((boxes[0].width_pt - 40.0).abs() < 0.5, "{boxes:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// M15's "indirectly produced content" case (design-principles.md rule
    /// 2 / phase3-single-view.md M15): a footnote's body text renders at the
    /// page bottom, nowhere near its reference mark in the running text.
    /// Its span still resolves to a real, locatable box — proving span-based
    /// range geometry keeps working for content whose *position* is decided
    /// by layout, not by source order, which is exactly the "fragment boxes
    /// for content pulled out of flow" case M14A set out to check.
    #[test]
    fn a_footnote_body_is_locatable_even_though_it_renders_away_from_its_reference() {
        let source = "Some running text.#footnote[The footnote body text.]";
        let (world, document) = compile(source);
        let boxes = geometry_for_range(&world, &document, range_of(source, "The footnote body text"));

        assert_eq!(boxes.len(), 1, "{boxes:?}");
        let reference_boxes = geometry_for_range(&world, &document, range_of(source, "running text"));
        assert_eq!(reference_boxes.len(), 1, "{reference_boxes:?}");
        assert!(
            boxes[0].y_top_pt > reference_boxes[0].y_top_pt,
            "footnote body should render below the reference text: {boxes:?} vs {reference_boxes:?}"
        );
    }

    /// A range that crosses a page break must come back with boxes on both
    /// pages, correctly attributed — the same per-page walk that already
    /// backs `jump_from_cursor`'s multi-page support (jump.rs), generalized
    /// to ranges.
    #[test]
    fn a_range_crossing_a_page_break_yields_boxes_on_both_pages() {
        let source = "#set page(height: 60pt, margin: 5pt)\n\
                       First page line.\n#pagebreak()\nSecond page line.";
        let (world, document) = compile(source);
        assert!(document.pages().len() >= 2, "fixture must actually paginate");

        let boxes = geometry_for_range(
            &world,
            &document,
            range_of(source, "First page line")
                .start..range_of(source, "Second page line").end,
        );

        let pages: std::collections::BTreeSet<_> = boxes.iter().map(|b| b.page).collect();
        assert_eq!(pages, std::collections::BTreeSet::from([1, 2]), "{boxes:?}");
    }
}
