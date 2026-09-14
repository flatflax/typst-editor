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
//!
//! Wired to the `block_geometry` Tauri command (compile.rs), which reuses
//! this module's per-range geometry for the M20 cursor/selection/hit-testing
//! work — see phase3-single-view.md's M15 entry for why the render/edit swap
//! this was originally prototyped for was abandoned in favor of that.

use std::ops::Range;

use serde::Serialize;
use typst::WorldExt;
use typst::layout::{Frame, FrameItem, Point};
use typst::syntax::Span;
use typst::text::Glyph;
use typst_layout::PagedDocument;

/// Vertical gap between stacked pages in `typst_svg::svg_merged`'s output.
/// Shared by `compile.rs` (passed straight to `svg_merged`) and
/// `page_offsets_pt` below, so the two can never drift apart — a page-offset
/// computed here must match the actual merged-SVG layout exactly, or
/// multi-page click/geometry mapping (M20) silently lands on the wrong page.
pub const PAGE_GAP_PT: f64 = 10.0;

/// The absolute Y (in `svg_merged`'s merged coordinate space) where each
/// page starts — `offsets[0] == 0.0`, `offsets[i] == offsets[i-1] +
/// height(page i-1) + PAGE_GAP_PT`. Mirrors `svg_merged`'s own stacking
/// arithmetic exactly (see its source: page heights summed with a fixed gap
/// between them, no bleed since `compile.rs` always renders with
/// `SvgOptions::default()`) rather than reimplementing page layout —
/// `page.frame.size()` is already the same size `svg_merged` itself uses per
/// page. Used by both directions of multi-page point-mapping: `jump_from_click`
/// (jump.rs) to turn a merged-SVG click point into a page + page-relative
/// point, and the frontend (via `CompileResult::page_offsets_pt`) to turn a
/// `RangeBox`'s page-relative `y_top_pt` back into a merged-SVG position for
/// rendering a caret/selection overlay.
pub fn page_offsets_pt(document: &PagedDocument) -> Vec<f64> {
    let mut offsets = Vec::with_capacity(document.pages().len());
    let mut y = 0.0;
    for page in document.pages() {
        offsets.push(y);
        y += page.frame.size().y.to_pt() + PAGE_GAP_PT;
    }
    offsets
}

/// One reconstructed visual line (for text) or one whole shape/image box,
/// in page-absolute point coordinates, `y_top_pt` measured from the page's
/// top-left as Typst frames do.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RangeBox {
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

/// For every rendered occurrence of each of `ranges` in `document`, return
/// one [`RangeBox`] per reconstructed visual line (text) or per shape/image.
/// Multiple boxes on the same page, or on different pages, both fall out
/// naturally from the same collection pass — no special-casing needed for
/// "this range wraps onto a second line" vs. "this range is a footnote body
/// rendered elsewhere on the page" vs. "this range crosses a page break":
/// each is just another non-adjacent hit.
///
/// Walks `document`'s frame tree exactly *once* regardless of how many
/// `ranges` are requested, bucketing each hit into whichever range it falls
/// in, instead of re-walking the whole tree once per range — which is what
/// this function used to do (one `geometry_for_range` per range, in a
/// loop). `block_geometry`'s real caller (`compile.rs`) requests one range
/// per on-screen block, so an N-block document used to cost N full tree
/// walks per call, each re-resolving every glyph's source span from
/// scratch — an O(blocks × glyphs) cost confirmed live on a genuinely long,
/// multi-page document (Phase 4, phase4-product-validation.md). Text hits
/// are bucketed by binary-searching `ranges` sorted by `start`
/// (`find_containing_range`) rather than checking every range against every
/// glyph — **this assumes `ranges` don't overlap**, true for
/// `blockByteRanges`-derived block boundaries (the only real caller) but
/// not enforced here; an overlapping pair would silently only credit the
/// hit to one of them. Image hits (far rarer than glyphs, and matched by
/// span-overlap rather than a single point) are still checked against every
/// range directly — not worth the same bucketing complexity for something
/// this infrequent. Results come back in the same order as `ranges`, not
/// sorted order.
pub fn geometry_for_ranges(
    world: &dyn typst::World,
    document: &PagedDocument,
    ranges: &[Range<usize>],
) -> Vec<Vec<RangeBox>> {
    if ranges.is_empty() {
        return Vec::new();
    }

    let mut order: Vec<usize> = (0..ranges.len()).collect();
    order.sort_by_key(|&i| ranges[i].start);

    let mut hits: Vec<Vec<Hit>> = (0..ranges.len()).map(|_| Vec::new()).collect();
    for (index, page) in document.pages().iter().enumerate() {
        collect_hits(world, &page.frame, Point::zero(), index + 1, ranges, &order, &mut hits);
    }
    hits.into_iter().map(cluster_into_boxes).collect()
}

/// Recursively walks `frame`, accumulating each item's position relative to
/// the page origin, and bucketing every hit into `hits[range_index]` for
/// whichever of `ranges` it belongs to (see [`geometry_for_ranges`]).
/// `origin` is only translated through nested `Group`s, not rotated/scaled
/// by `GroupItem::transform` — a known simplification (see
/// phase3-single-view.md) that holds for ordinary flow content (paragraphs,
/// headings, lists, images) but not for content under `#rotate`/`#scale`.
fn collect_hits(
    world: &dyn typst::World,
    frame: &Frame,
    origin: Point,
    page: usize,
    ranges: &[Range<usize>],
    order: &[usize],
    hits: &mut [Vec<Hit>],
) {
    for &(pos, ref item) in frame.items() {
        let abs_pos = origin + pos;
        match item {
            FrameItem::Group(group) => {
                collect_hits(world, &group.frame, abs_pos, page, ranges, order, hits);
            }
            FrameItem::Text(text) => {
                let mut x = abs_pos.x;
                for glyph in &text.glyphs {
                    let width = glyph.x_advance.at(text.size);
                    if let Some(range_index) = glyph_source_offset(world, glyph)
                        .and_then(|o| find_containing_range(ranges, order, o))
                    {
                        // Typst's `Frame` doesn't expose real font-metrics
                        // ascent/descent for a glyph run, only the font
                        // size used to lay it out — the same approximation
                        // typst-ide's own click hit-testing uses (jump.rs:
                        // `pos.y - text.size` .. `pos.y`).
                        let ascent = text.size.to_pt();
                        let descent = ascent * 0.25;
                        hits[range_index].push(Hit {
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
                for (range_index, range) in ranges.iter().enumerate() {
                    if span_overlaps(world, *span, range) {
                        hits[range_index].push(Hit {
                            page,
                            x_pt: abs_pos.x.to_pt(),
                            y_top_pt: abs_pos.y.to_pt(),
                            width_pt: size.x.to_pt(),
                            height_pt: size.y.to_pt(),
                            baseline_from_top_pt: None,
                        });
                    }
                }
            }
            _ => {}
        }
    }
}

/// Finds which of `ranges` contains `offset`, via `order` (indices into
/// `ranges` sorted by `start`) — binary search for the last range starting
/// at or before `offset`, then a single containment check, in place of
/// checking every range in turn. Relies on `ranges` not overlapping (see
/// [`geometry_for_ranges`]'s own doc comment): with overlapping ranges this
/// picks at most one of them, not every match.
fn find_containing_range(ranges: &[Range<usize>], order: &[usize], offset: usize) -> Option<usize> {
    let pos = order.partition_point(|&i| ranges[i].start <= offset);
    if pos == 0 {
        return None;
    }
    let candidate = order[pos - 1];
    ranges[candidate].contains(&offset).then_some(candidate)
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

    /// Single-range convenience wrapper around `geometry_for_ranges`, kept
    /// as a private test helper (not production API — `block_geometry`'s
    /// real caller always wants the batched form) since most tests below
    /// only care about one range at a time.
    fn geometry_for_range(
        world: &dyn typst::World,
        document: &PagedDocument,
        range: Range<usize>,
    ) -> Vec<RangeBox> {
        geometry_for_ranges(world, document, std::slice::from_ref(&range))
            .into_iter()
            .next()
            .unwrap_or_default()
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

    /// The whole point of `geometry_for_ranges`: batching several ranges into
    /// one tree walk must produce exactly the same per-range boxes as the old
    /// approach of calling `geometry_for_range` once per range — a golden
    /// regression guard that the walk-once-and-bucket rewrite didn't change
    /// any actual result, only how many times the tree gets walked.
    #[test]
    fn geometry_for_ranges_matches_calling_geometry_for_range_once_per_range() {
        let source = "First paragraph here.\n\n\
                       Second paragraph, a bit longer than the first one.\n\n\
                       Third.";
        let (world, document) = compile(source);
        let ranges = vec![
            range_of(source, "First paragraph here."),
            range_of(source, "Second paragraph, a bit longer than the first one."),
            range_of(source, "Third."),
        ];

        let batched = geometry_for_ranges(&world, &document, &ranges);
        let individually: Vec<Vec<RangeBox>> = ranges
            .iter()
            .map(|r| geometry_for_range(&world, &document, r.clone()))
            .collect();
        assert_eq!(batched, individually);
        assert!(batched.iter().all(|boxes| !boxes.is_empty()), "{batched:?}");
    }

    /// Results must come back indexed by the caller's own input order, not
    /// re-sorted into document order — `order` (sorted by `start`, used
    /// internally for the binary search) must never leak into the output.
    #[test]
    fn geometry_for_ranges_preserves_input_order_even_when_ranges_are_passed_out_of_document_order() {
        let source = "Alpha paragraph.\n\nBravo paragraph.";
        let (world, document) = compile(source);
        let alpha = range_of(source, "Alpha paragraph.");
        let bravo = range_of(source, "Bravo paragraph.");

        // Deliberately reversed: bravo (later in the document) requested first.
        let results = geometry_for_ranges(&world, &document, &[bravo.clone(), alpha.clone()]);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].len(), 1, "{results:?}");
        assert_eq!(results[1].len(), 1, "{results:?}");
        assert!(
            results[0][0].y_top_pt > results[1][0].y_top_pt,
            "results[0] must be bravo's (lower) box and results[1] alpha's (higher) box, \
             matching the input order [bravo, alpha]: {results:?}"
        );
    }

    #[test]
    fn geometry_for_ranges_returns_an_empty_vec_for_an_empty_ranges_list() {
        let (world, document) = compile("Hello world.");
        assert_eq!(geometry_for_ranges(&world, &document, &[]), Vec::<Vec<RangeBox>>::new());
    }

    #[test]
    fn page_offsets_pt_matches_svg_merged_own_stacking_for_a_single_page() {
        let (_, document) = compile("Hello world.");
        assert_eq!(page_offsets_pt(&document), vec![0.0]);
    }

    /// Must match `typst_svg::svg_merged`'s own arithmetic exactly (cumulative
    /// page heights plus `PAGE_GAP_PT` between them) — this is the one piece
    /// of the merged coordinate space `svg_merged` itself doesn't expose, so
    /// this function's whole job is not drifting from what it actually does.
    #[test]
    fn page_offsets_pt_accumulates_page_height_plus_gap_for_each_page() {
        let source = "#set page(height: 60pt, margin: 5pt)\n\
                       First page line.\n#pagebreak()\nSecond page line.\n#pagebreak()\nThird page line.";
        let (_, document) = compile(source);
        assert_eq!(document.pages().len(), 3, "fixture must actually paginate into 3 pages");

        let offsets = page_offsets_pt(&document);
        assert_eq!(offsets.len(), 3);
        assert_eq!(offsets[0], 0.0);
        for i in 1..3 {
            let expected = offsets[i - 1] + document.pages()[i - 1].frame.size().y.to_pt() + PAGE_GAP_PT;
            assert!((offsets[i] - expected).abs() < 1e-9, "{offsets:?}");
        }
    }
}
