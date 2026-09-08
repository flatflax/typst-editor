//! `compile_typst` Tauri command: takes raw Typst source, compiles it with
//! the real Typst engine, and returns a merged SVG preview plus diagnostics.
//!
//! M14 (plan.md) measured that a fresh `TauriWorld`/`Source` per call
//! discards `comemo`'s memoization entirely, and that a session-held
//! `World` + `Source::edit` is a low-risk win for the common case (repeat
//! compiles of unchanged content become near-free). This module now holds
//! one `TauriWorld` per app session (`Mutex<TauriWorld>`, managed in
//! lib.rs) instead of constructing one per call — matching `typst::World`'s
//! own doc comment: "Advanced clients like language servers can also retain
//! the source files and edit them in-place to benefit from better
//! incremental performance." The frontend still sends the whole current
//! document on every call (unchanged IPC shape); `compute_edit` recovers the
//! underlying single-keystroke edit by diffing it against the session's
//! previous text, since Typst has no API to apply an edit without first
//! knowing its byte range.

use std::ops::Range;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use typst::diag::{EcoVec, Severity, SourceDiagnostic};
use typst::layout::Abs;
use typst::{World, WorldExt};
use typst_layout::PagedDocument;
use typst_svg::SvgOptions;

use crate::geometry;
use crate::typst_world::TauriWorld;

#[derive(Serialize)]
pub struct CompileDiagnostic {
    severity: &'static str,
    message: String,
    /// 1-indexed source line/column, when the diagnostic's span resolves to
    /// a position in the compiled source (absent for detached spans, e.g.
    /// some global-level errors) — lets the frontend place a gutter/inline
    /// marker at the exact failing line instead of just listing text.
    line: Option<usize>,
    column: Option<usize>,
}

#[derive(Serialize)]
pub struct CompileResult {
    svg: Option<String>,
    diagnostics: Vec<CompileDiagnostic>,
}

fn to_diagnostic(world: &TauriWorld, diag: &SourceDiagnostic) -> CompileDiagnostic {
    let position = world.range(diag.span).and_then(|range| {
        let source = world.source(world.main()).ok()?;
        source.lines().byte_to_line_column(range.start)
    });

    CompileDiagnostic {
        severity: match diag.severity {
            Severity::Error => "error",
            Severity::Warning => "warning",
        },
        message: diag.message.to_string(),
        line: position.map(|(line, _)| line + 1),
        column: position.map(|(_, column)| column + 1),
    }
}

/// Formats compile/export errors as `"line:column: message"` lines (falling
/// back to just the message for spans that don't resolve to a position),
/// joined with newlines — used by `export_pdf` (export.rs) to surface real
/// Typst diagnostics through a plain `Result<(), String>` Tauri error rather
/// than duplicating `CompileDiagnostic`'s line/column plumbing there.
pub(crate) fn diagnostics_to_string(world: &TauriWorld, diags: &EcoVec<SourceDiagnostic>) -> String {
    diags
        .iter()
        .map(|d| {
            let diag = to_diagnostic(world, d);
            match (diag.line, diag.column) {
                (Some(line), Some(column)) => format!("{line}:{column}: {}", diag.message),
                _ => diag.message,
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The smallest `Source::edit`-compatible edit (byte range to replace, plus
/// replacement text) that turns `old` into `new`: trim the longest common
/// prefix and suffix, snapped to UTF-8 char boundaries so a shared prefix/
/// suffix that happens to end mid-multi-byte-character never produces an
/// invalid byte range. A single keystroke anywhere in the document reduces
/// to a small edit at that point; pasting or replacing the whole document
/// reduces to one large edit spanning most of it — both are just points on
/// the same continuum, not special-cased.
fn compute_edit<'new>(old: &str, new: &'new str) -> (Range<usize>, &'new str) {
    let prefix = common_prefix_len(old, new);
    let max_suffix = old.len().min(new.len()) - prefix;
    let suffix = common_suffix_len(old, new, max_suffix);
    (prefix..old.len() - suffix, &new[prefix..new.len() - suffix])
}

fn common_prefix_len(a: &str, b: &str) -> usize {
    let mut len = a.bytes().zip(b.bytes()).take_while(|(x, y)| x == y).count();
    while len > 0 && !(a.is_char_boundary(len) && b.is_char_boundary(len)) {
        len -= 1;
    }
    len
}

/// Common suffix length of `a`/`b`, capped at `max` so it can never overlap
/// a prefix already claimed by [`common_prefix_len`].
fn common_suffix_len(a: &str, b: &str, max: usize) -> usize {
    let mut len = 0;
    for (x, y) in a.bytes().rev().zip(b.bytes().rev()) {
        if len >= max || x != y {
            break;
        }
        len += 1;
    }
    while len > 0 && !(a.is_char_boundary(a.len() - len) && b.is_char_boundary(b.len() - len)) {
        len -= 1;
    }
    len
}

/// Applies `source`/`base_dir` to a session's `TauriWorld` in place, via a
/// diffed incremental `Source::edit` rather than a reconstruction (see this
/// module's doc comment) — shared by `compile_with_world` and
/// `block_geometry_with_world` so both commands see the same session state
/// without duplicating the diff-and-edit logic.
fn sync_session(world: &mut TauriWorld, source: String, base_dir: Option<PathBuf>) {
    world.set_base_dir(base_dir);

    let old_text = world.text();
    if old_text != source {
        let (range, replacement) = compute_edit(old_text, &source);
        world.edit_source(range, replacement);
    }
}

/// The actual, testable compile logic: apply `source`/`base_dir` to a
/// caller-held `TauriWorld` — via a diffed incremental `Source::edit`, not a
/// reconstruction — and compile. Split out from the `#[tauri::command]`
/// below purely so tests can call it directly against a `TauriWorld` they
/// construct themselves, without needing a running Tauri app to obtain a
/// `State`.
fn compile_with_world(world: &mut TauriWorld, source: String, base_dir: Option<PathBuf>) -> CompileResult {
    sync_session(world, source, base_dir);

    let warned = typst::compile::<PagedDocument>(&*world);

    let mut diagnostics: Vec<CompileDiagnostic> =
        warned.warnings.iter().map(|d| to_diagnostic(world, d)).collect();

    match warned.output {
        Ok(document) => {
            let svg = typst_svg::svg_merged(&document, &SvgOptions::default(), Abs::pt(10.0));
            CompileResult { svg: Some(svg), diagnostics }
        }
        Err(errors) => {
            diagnostics.extend(errors.iter().map(|d| to_diagnostic(world, d)));
            CompileResult { svg: None, diagnostics }
        }
    }
}

/// `base_dir` (plan.md M11) is the open document's directory (`None` before
/// any file has been opened/saved), used to resolve `#image("path")` — see
/// `TauriWorld::file`. Threaded through from `App.tsx`'s `filePath` on every
/// compile, not just at load time, so editing/saving-as a document with
/// relative image paths always resolves against whatever is currently open
/// (a session's `TauriWorld` outlives any single open document, so this is
/// applied fresh on every call rather than only at session start).
///
/// `session` is this app's single `TauriWorld`, held for the process
/// lifetime (managed in lib.rs) — see this module's doc comment for why.
#[tauri::command]
pub fn compile_typst(
    source: String,
    base_dir: Option<String>,
    session: tauri::State<'_, Mutex<TauriWorld>>,
) -> CompileResult {
    let mut world = session.lock().unwrap();
    compile_with_world(&mut world, source, base_dir.map(PathBuf::from))
}

/// Rendered geometry for each of `ranges`, reusing the session's
/// `TauriWorld` exactly like `compile_with_world` does. `compile_typst` and
/// `block_geometry` are typically called back-to-back for the same source,
/// so this second `typst::compile` call is effectively free — `comemo`'s
/// full cache hit on unchanged content, per M14's persistent-`World`
/// benchmark — not a second real recompile. A failed compile returns one
/// empty `Vec` per requested range rather than erroring, matching
/// `geometry_for_range`'s own "no match" behavior for an unmatched range.
fn block_geometry_with_world(
    world: &mut TauriWorld,
    source: String,
    base_dir: Option<PathBuf>,
    ranges: Vec<(usize, usize)>,
) -> Vec<Vec<geometry::RangeBox>> {
    sync_session(world, source, base_dir);

    match typst::compile::<PagedDocument>(&*world).output {
        Ok(document) => ranges
            .into_iter()
            .map(|(start, end)| geometry::geometry_for_range(&*world, &document, start..end))
            .collect(),
        Err(_) => ranges.iter().map(|_| Vec::new()).collect(),
    }
}

/// Batched (one round trip covering every range the frontend needs
/// positioned, not one call per range) — M14A's `geometry_for_range`, wired
/// to the frontend for M20's cursor/selection/hit-testing work.
#[tauri::command]
pub fn block_geometry(
    source: String,
    base_dir: Option<String>,
    ranges: Vec<(usize, usize)>,
    session: tauri::State<'_, Mutex<TauriWorld>>,
) -> Vec<Vec<geometry::RangeBox>> {
    let mut world = session.lock().unwrap();
    block_geometry_with_world(&mut world, source, base_dir.map(PathBuf::from), ranges)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The outer `compile_typst` is now a thin `#[tauri::command]` shim over
    // `compile_with_world` (a `tauri::State` isn't constructible without a
    // running Tauri app) — these helpers call `compile_with_world` directly
    // against a fresh `TauriWorld` instead, giving every test below the same
    // per-call isolation the old 2-arg `compile_typst` had (no session
    // persists *between* tests; the `session_*` tests further down exercise
    // persistence *within* one deliberately).
    fn compile_typst_with_base_dir(source: String, base_dir: Option<String>) -> CompileResult {
        let mut world = TauriWorld::new(String::new(), None);
        compile_with_world(&mut world, source, base_dir.map(PathBuf::from))
    }

    fn compile_typst(source: String) -> CompileResult {
        compile_typst_with_base_dir(source, None)
    }

    mod compute_edit_tests {
        use super::compute_edit;

        #[test]
        fn identical_strings_produce_an_empty_edit() {
            let (range, replacement) = compute_edit("hello world", "hello world");
            assert_eq!(range, 11..11);
            assert_eq!(replacement, "");
        }

        #[test]
        fn a_single_inserted_character_is_a_minimal_edit() {
            let (range, replacement) = compute_edit("hello world", "hello, world");
            assert_eq!(range, 5..5);
            assert_eq!(replacement, ",");
        }

        #[test]
        fn a_deletion_in_the_middle_is_a_minimal_edit() {
            let (range, replacement) = compute_edit("hello world", "hello orld");
            assert_eq!(range, 6..7);
            assert_eq!(replacement, "");
        }

        #[test]
        fn totally_different_strings_still_produce_a_valid_edit() {
            let (range, replacement) = compute_edit("abc", "xyz");
            assert_eq!(range, 0..3);
            assert_eq!(replacement, "xyz");
        }

        #[test]
        fn empty_old_string_is_a_pure_insertion() {
            let (range, replacement) = compute_edit("", "new content");
            assert_eq!(range, 0..0);
            assert_eq!(replacement, "new content");
        }

        #[test]
        fn empty_new_string_is_a_pure_deletion() {
            let (range, replacement) = compute_edit("old content", "");
            assert_eq!(range, 0..11);
            assert_eq!(replacement, "");
        }

        /// The char-boundary-snapping regression guard: U+4E00 ("一") and
        /// U+4E01 ("丁") both encode as 3 UTF-8 bytes sharing their first two
        /// bytes (`E4 B8`) and differing only in the third (`80` vs `81`) —
        /// so a naive byte-by-byte common-prefix scan finds 2 matching bytes
        /// before the mismatch, landing *inside* the character rather than
        /// before or after it. Slicing a string at a non-boundary byte index
        /// panics, so every computed boundary must land on a real char
        /// boundary in *both* strings, not just wherever bytes stop matching.
        #[test]
        fn multi_byte_characters_never_produce_a_boundary_inside_a_character() {
            let old = "丁二三四五";
            let new = "一二三四五";
            let (range, replacement) = compute_edit(old, new);
            assert!(old.is_char_boundary(range.start) && old.is_char_boundary(range.end));
            assert_eq!(range, 0..3, "should snap down to replacing the whole first character");
            assert_eq!(replacement, "一");
            // Applying the edit must reproduce `new` exactly.
            let mut rebuilt = old.to_string();
            rebuilt.replace_range(range, replacement);
            assert_eq!(rebuilt, new);
        }
    }

    /// A session-held `TauriWorld` (M14's follow-up (a), now real rather
    /// than benchmark-only) must keep producing *correct* output across a
    /// sequence of incremental edits, not just fast ones — M14's own
    /// benchmarks already covered speed; these cover correctness of the
    /// diff-then-`Source::edit` path `compile_with_world` now always takes.
    #[test]
    fn a_session_produces_correct_output_across_a_sequence_of_incremental_edits() {
        let mut world = TauriWorld::new(String::new(), None);

        let first = compile_with_world(&mut world, "= Hello".into(), None);
        assert!(first.diagnostics.is_empty());
        assert!(first.svg.is_some());

        // Same content as a from-scratch compile would produce — this is
        // the correctness property that matters, not merely "doesn't crash".
        let expected_after_edit = compile_typst("= Hello, world!".into());
        let after_edit = compile_with_world(&mut world, "= Hello, world!".into(), None);
        assert_eq!(after_edit.svg, expected_after_edit.svg);

        // An edit that introduces an error, then one that fixes it again —
        // the session must recover cleanly in both directions.
        let broken = compile_with_world(&mut world, "#unknown_function()".into(), None);
        assert!(broken.svg.is_none());
        assert!(!broken.diagnostics.is_empty());

        let expected_fixed = compile_typst("= Hello, world!".into());
        let fixed = compile_with_world(&mut world, "= Hello, world!".into(), None);
        assert_eq!(fixed.svg, expected_fixed.svg);
        assert!(fixed.diagnostics.is_empty());
    }

    /// `base_dir` must update within a session (e.g. after Save As), not
    /// only at construction — `TauriWorld` outlives any single open
    /// document now, unlike before this change.
    #[test]
    fn a_session_resolves_images_against_a_base_dir_set_after_construction() {
        let dir = std::env::temp_dir().join(format!("typst-editor-test-session-img-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("photo.png"), minimal_png()).unwrap();

        let mut world = TauriWorld::new(String::new(), None);
        compile_with_world(&mut world, "no image yet".into(), None);

        let result = compile_with_world(
            &mut world,
            "#image(\"photo.png\")".into(),
            Some(dir.clone()),
        );
        assert!(
            result.diagnostics.iter().all(|d| d.severity != "error"),
            "unexpected error diagnostics: {:?}",
            result.diagnostics.iter().map(|d| &d.message).collect::<Vec<_>>()
        );
        assert!(result.svg.is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `block_geometry`'s underlying logic returns real page-1 boxes for a
    /// range that actually renders — the same span-matching
    /// `geometry_for_range` (geometry.rs) already proved, exercised here
    /// through the session-held `TauriWorld` path the real command uses.
    #[test]
    fn block_geometry_returns_boxes_for_a_range_that_renders() {
        let source = "= A Heading\n\nSome body text.";
        let mut world = TauriWorld::new(String::new(), None);
        let heading_start = source.find("A Heading").unwrap();
        let heading_end = heading_start + "A Heading".len();

        let results =
            block_geometry_with_world(&mut world, source.into(), None, vec![(heading_start, heading_end)]);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].len(), 1, "{:?}", results[0]);
        assert_eq!(results[0][0].page, 1);
    }

    /// A range with nothing rendered at it (out of bounds, or pointing at a
    /// compiler directive with no visual output) comes back as an empty
    /// `Vec`, not an error — matching `geometry_for_range`'s own "no match"
    /// behavior, so the frontend can treat "no geometry yet" uniformly.
    #[test]
    fn block_geometry_returns_an_empty_vec_for_a_range_with_no_rendered_content() {
        let source = "Hello world.";
        let mut world = TauriWorld::new(String::new(), None);

        let results = block_geometry_with_world(&mut world, source.into(), None, vec![(1000, 1010), (0, 0)]);

        assert_eq!(results, vec![Vec::new(), Vec::new()]);
    }

    /// A source that fails to compile must degrade to empty `Vec`s (one per
    /// requested range) rather than panicking — mirrors
    /// `reports_diagnostics_instead_of_crashing_on_invalid_source` for
    /// `compile_typst`.
    #[test]
    fn block_geometry_degrades_to_empty_vecs_on_a_compile_failure() {
        let source = "#unknown_function()";
        let mut world = TauriWorld::new(String::new(), None);

        let results = block_geometry_with_world(&mut world, source.into(), None, vec![(0, source.len())]);

        assert_eq!(results, vec![Vec::new()]);
    }

    #[test]
    fn compiles_valid_source_to_svg_with_no_diagnostics() {
        let result = compile_typst("= Hello\n\nThis is *bold* and _italic_.".into());
        assert!(result.diagnostics.is_empty(), "unexpected diagnostics: {:?}", result.diagnostics.iter().map(|d| &d.message).collect::<Vec<_>>());
        let svg = result.svg.expect("expected an svg for valid source");
        assert!(svg.starts_with("<svg"));

        // The rendered SVG should reflect the actual source content: a
        // heading produces more/larger glyph paths than an empty document,
        // so the two outputs must differ and the non-empty one must be
        // substantially larger than a near-empty baseline.
        let empty = compile_typst(String::new()).svg.expect("expected an svg for empty source");
        assert_ne!(svg, empty);
        assert!(svg.len() > empty.len() * 2);
    }

    #[test]
    fn reports_diagnostics_instead_of_crashing_on_invalid_source() {
        let result = compile_typst("#unknown_function()".into());
        assert!(result.svg.is_none());
        assert!(!result.diagnostics.is_empty());
        assert_eq!(result.diagnostics[0].severity, "error");
    }

    #[test]
    fn diagnostics_resolve_to_the_correct_1_indexed_line_and_column() {
        let result = compile_typst("= Heading\n\n#unknown_function()".into());
        assert_eq!(result.diagnostics.len(), 1);
        let diagnostic = &result.diagnostics[0];
        assert_eq!(diagnostic.line, Some(3), "message: {}", diagnostic.message);
        assert_eq!(diagnostic.column, Some(2), "message: {}", diagnostic.message);
    }

    /// Confirms the premise behind "typst_set is trivially stable under
    /// round-trip by construction" (plan.md M3): preserving a `#set` rule
    /// verbatim (src-tauri/src/ast.rs, src/spokes/typstAst.ts) only matters because
    /// it actually changes the compiled output. This proves that half —
    /// that dropping the rule (what would happen without this feature)
    /// visibly changes the real Typst compiler's rendered SVG — using
    /// `parse_typst_ast` to confirm the rule is recognized in the first
    /// place.
    #[test]
    fn set_rule_settings_have_a_real_visual_effect_on_the_compiled_output() {
        use crate::ast::{TypstSet, parse_typst_ast};

        let with_set = "#set text(size: 30pt)\n\nHello";
        let without_set = "Hello";

        let doc = parse_typst_ast(with_set.into());
        assert_eq!(
            doc.settings,
            vec![TypstSet { function: "text".into(), raw: "#set text(size: 30pt)".into() }]
        );

        let with_set_svg = compile_typst(with_set.into()).svg.expect("valid source");
        let without_set_svg = compile_typst(without_set.into()).svg.expect("valid source");
        assert_ne!(
            with_set_svg, without_set_svg,
            "expected #set text(size: ...) to change the rendered output"
        );
    }

    /// Proves `#link("url")[body]` (plan.md M9) isn't just recognized by
    /// `parse_typst_ast` (ast.rs's link tests) but is real, compilable Typst
    /// — mirrors set_rule_settings_have_a_real_visual_effect_on_the_compiled_output's
    /// "parsed doesn't mean compiles" caution for a different construct.
    #[test]
    fn link_call_compiles_successfully_through_the_real_typst_engine() {
        let result = compile_typst("See #link(\"https://typst.app\")[the docs] for more.".into());
        assert!(
            result.diagnostics.iter().all(|d| d.severity != "error"),
            "unexpected error diagnostics: {:?}",
            result.diagnostics.iter().map(|d| &d.message).collect::<Vec<_>>()
        );
        assert!(result.svg.is_some());
    }

    /// Proves `#table(columns: .., [cell], ...)` (plan.md M10) isn't just
    /// recognized by `parse_typst_ast` (ast.rs's table tests) but is real,
    /// compilable Typst — same "parsed doesn't mean compiles" caution as
    /// link_call_compiles_successfully_through_the_real_typst_engine.
    #[test]
    fn table_call_compiles_successfully_through_the_real_typst_engine() {
        let result = compile_typst("#table(columns: 2, [A], [B], [C], [D])".into());
        assert!(
            result.diagnostics.iter().all(|d| d.severity != "error"),
            "unexpected error diagnostics: {:?}",
            result.diagnostics.iter().map(|d| &d.message).collect::<Vec<_>>()
        );
        assert!(result.svg.is_some());
    }

    // A real, freshly-encoded 1x1 PNG (via the `image` dev-dependency, not
    // hand-typed bytes with hand-computed CRC/Adler32 checksums — Typst's
    // `image()` genuinely decodes the file, so it has to be one a decoder
    // actually accepts).
    fn minimal_png() -> Vec<u8> {
        let mut bytes = Vec::new();
        image::RgbImage::new(1, 1)
            .write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();
        bytes
    }

    /// Image resolution end to end (plan.md M11): `base_dir` is the *only*
    /// mechanism `#image("path")` can reach a real file through — a fresh
    /// temp directory containing a real (decodable) PNG, threaded through
    /// `compile_typst`'s `base_dir` parameter exactly as `App.tsx` threads
    /// the open document's directory.
    #[test]
    fn image_with_a_real_file_in_base_dir_compiles_successfully() {
        let dir = std::env::temp_dir().join(format!("typst-editor-test-compile-img-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("photo.png"), minimal_png()).unwrap();

        let result = compile_typst_with_base_dir("#image(\"photo.png\")".into(), Some(dir.to_str().unwrap().into()));
        assert!(
            result.diagnostics.iter().all(|d| d.severity != "error"),
            "unexpected error diagnostics: {:?}",
            result.diagnostics.iter().map(|d| &d.message).collect::<Vec<_>>()
        );
        assert!(result.svg.is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// plan.md M11: "a manual check that a missing/broken image path
    /// degrades to a diagnostic rather than a crash" — automated here
    /// instead, same spirit as reports_diagnostics_instead_of_crashing_on_invalid_source.
    #[test]
    fn image_with_a_missing_file_degrades_to_a_diagnostic_not_a_crash() {
        let dir = std::env::temp_dir().join(format!("typst-editor-test-compile-img-missing-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let result =
            compile_typst_with_base_dir("#image(\"nope.png\")".into(), Some(dir.to_str().unwrap().into()));
        assert!(result.svg.is_none());
        assert!(!result.diagnostics.is_empty());
        assert_eq!(result.diagnostics[0].severity, "error");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The realistic, user-triggerable version of
    /// typst_world.rs's `a_dot_dot_escaping_virtual_path_cannot_even_be_constructed`:
    /// a document actually containing `#image("../secret.png")`, compiled
    /// for real through the full command, degrades to a diagnostic — not a
    /// crash, and (the actual security property) never reads the file that
    /// genuinely exists just outside `base_dir`.
    #[test]
    fn image_path_escaping_base_dir_is_rejected_end_to_end() {
        let root = std::env::temp_dir().join(format!("typst-editor-test-compile-escape-{}", std::process::id()));
        let base_dir = root.join("project");
        std::fs::create_dir_all(&base_dir).unwrap();
        std::fs::write(root.join("secret.png"), minimal_png()).unwrap();

        let result = compile_typst_with_base_dir(
            "#image(\"../secret.png\")".into(),
            Some(base_dir.to_str().unwrap().into()),
        );
        assert!(result.svg.is_none(), "the escaping path must not resolve to a real image");
        assert!(!result.diagnostics.is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }

    // Same source as ast::tests::MIXED_DOCUMENT (duplicated here rather than
    // shared — `CompileResult`'s fields are private, so the compile-diff and
    // perf checks for it have to live in this module, and Rust's per-file
    // `#[cfg(test)] mod tests` visibility makes cross-file test-only sharing
    // more trouble than a few duplicated lines are worth).
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

    /// Compile-diff half of the M6 gate: the mixed document (real headings,
    /// marks, lists, a call, a `#set`, *and* an unsupported math block all
    /// together) must actually compile through the real Typst engine, not
    /// just parse — proving `unsupported_block`'s verbatim raw text is still
    /// syntactically valid Typst in context, not just opaque to our parser.
    #[test]
    fn mixed_document_compiles_successfully() {
        let result = compile_typst(MIXED_DOCUMENT.into());
        assert!(
            result.diagnostics.iter().all(|d| d.severity != "error"),
            "unexpected error diagnostics: {:?}",
            result.diagnostics.iter().map(|d| &d.message).collect::<Vec<_>>()
        );
        assert!(result.svg.is_some());
    }

    /// Basic perf sanity check (plan.md M6): full recompilation must stay
    /// comfortably under the frontend's debounce window (250ms,
    /// COMPILE_DEBOUNCE_MS in App.tsx) for an MVP-sized document, so
    /// recompile-per-keystroke doesn't feel laggy. Warms up first: the
    /// *very first* compile in a process pays a one-time system-font-scan
    /// cost (see typst_world.rs's `LazyLock` note) that has nothing to do
    /// with per-keystroke recompile speed — real usage only pays that once
    /// per app launch, not once per edit. Generous margin on top of that
    /// (also covers this test binary's own parallel-test CPU contention) —
    /// a regression guard against an accidental perf cliff, not a tight
    /// benchmark.
    #[test]
    fn compiling_an_mvp_sized_document_is_well_under_the_debounce_window() {
        use std::time::Instant;

        compile_typst(MIXED_DOCUMENT.into()); // warm up the font-book cache

        let start = Instant::now();
        let result = compile_typst(MIXED_DOCUMENT.into());
        let elapsed = start.elapsed();

        assert!(result.svg.is_some());
        assert!(
            elapsed.as_millis() < 250,
            "compile_typst took {elapsed:?} after warmup, expected well under the 250ms debounce window"
        );
    }

    /// Builds a deterministic, realistically long document (`sections`
    /// headings, each with two filler paragraphs and a bullet list) so M14's
    /// spike measures against something closer to a real multi-page document
    /// than `MIXED_DOCUMENT` — that one is a single page.
    fn multi_page_fixture(sections: usize) -> String {
        const SENTENCE: &str = "The quick brown fox jumps over the lazy dog while autumn leaves drift across the quiet valley below the ridge.";
        let paragraph = format!("{SENTENCE} {SENTENCE} {SENTENCE} {SENTENCE}");
        let mut doc = String::from("#set text(size: 11pt)\n\n");
        for i in 0..sections {
            doc.push_str(&format!(
                "= Section {i}\n\n{paragraph}\n\n{paragraph}\n\n- Alpha\n- Beta\n- Gamma\n\n"
            ));
        }
        doc
    }

    /// M14 (plan.md): before assuming block-scoped/partial compilation is
    /// required for the single-view swap mechanism (M15+), measure whether
    /// recompiling the *whole* document after a single-character edit,
    /// applied to a realistic multi-page fixture, already lands under a
    /// per-keystroke budget. Prints the actual measurement
    /// (`cargo test --release -- --nocapture`) since the point of a spike is
    /// the number itself, not just a pass/fail — see phase3-single-view.md
    /// for the recorded release-mode result (~75-390ms depending on page
    /// count, scaling roughly linearly) and its consequence for M15's
    /// design.
    ///
    /// Unlike `compiling_an_mvp_sized_document_is_well_under_the_debounce_window`,
    /// this doesn't assert a tight release-mode budget: Typst's layout pass
    /// is 10x+ slower under `cargo test`'s default debug profile (measured
    /// ~870ms for this same fixture vs. ~75ms release), so a threshold tight
    /// enough to mean anything in release would make this test fail every
    /// debug run. The loose ceiling below only guards against a genuine
    /// hang/regression; the real answer to M14's question has to come from
    /// a `--release` run, recorded in the docs rather than pinned in CI.
    #[test]
    fn single_character_edit_on_a_multi_page_document_recompile_latency() {
        use std::time::Instant;

        let fixture = multi_page_fixture(40);

        compile_typst(fixture.clone()); // warm up the font-book cache

        // Confirm the fixture is genuinely multi-page before treating the
        // timing below as informative for M14's question.
        let world = TauriWorld::new(fixture.clone(), None);
        let page_count = typst::compile::<PagedDocument>(&world)
            .output
            .expect("fixture must compile")
            .pages()
            .len();
        assert!(
            page_count >= 5,
            "fixture only produced {page_count} page(s), not realistically multi-page — increase `sections`"
        );

        let start = Instant::now();
        let baseline = compile_typst(fixture.clone());
        let baseline_elapsed = start.elapsed();
        assert!(baseline.svg.is_some());

        // Simulate one keystroke: insert a single character mid-document
        // (ASCII filler text throughout, so any byte offset is a char
        // boundary) rather than editing at an edge, where a real edit is
        // most likely to land in a multi-page document.
        let mid = fixture.len() / 2;
        let mut edited = fixture.clone();
        edited.insert(mid, 'x');

        let start = Instant::now();
        let edited_result = compile_typst(edited);
        let edit_elapsed = start.elapsed();
        assert!(edited_result.svg.is_some());

        eprintln!(
            "M14 spike: {page_count}-page fixture — whole-doc recompile after warmup: \
             {baseline_elapsed:?}; after a single-character edit: {edit_elapsed:?}"
        );

        assert!(
            edit_elapsed.as_millis() < 5000,
            "single-character-edit recompile took {edit_elapsed:?} on a {page_count}-page \
             document — that's far beyond even debug-profile levels of slow, likely a hang \
             or a real regression rather than normal build-profile variance"
        );
    }

    /// M14, second half: `single_character_edit_on_a_multi_page_document_recompile_latency`
    /// measures the *current* `compile_typst` architecture, which builds a
    /// fresh `TauriWorld` (and so a fresh `Source`/`FileId`) on every call —
    /// that discards `comemo`'s memoization entirely, since cached results
    /// are keyed against the old `FileId`/`Source` instance. This variant
    /// keeps one `TauriWorld` alive and uses `Source::edit` (incremental
    /// reparse, same mechanism `typst-cli --watch` uses) to apply the same
    /// single-character edit, to see whether `comemo` gives a real speedup
    /// once the World/FileId are actually held stable across edits — the
    /// premise M14 set out to check ("`typst::compile` already uses
    /// `comemo`-based memoization internally").
    #[test]
    fn incremental_edit_on_a_persistent_world_shows_comemos_real_speedup() {
        use std::time::Instant;

        let fixture = multi_page_fixture(40);
        let mut world = TauriWorld::new(fixture.clone(), None);

        // Warm up: first compile of this World pays the same one-time costs
        // as compile_typst's own warmup call.
        typst::compile::<PagedDocument>(&world).output.expect("fixture must compile");

        let start = Instant::now();
        typst::compile::<PagedDocument>(&world).output.expect("fixture must compile");
        let unedited_repeat_elapsed = start.elapsed();

        let mid = fixture.len() / 2;
        world.edit_source(mid..mid, "x");

        let start = Instant::now();
        let edited = typst::compile::<PagedDocument>(&world).output.expect("edited fixture must compile");
        let _ = typst_svg::svg_merged(&edited, &SvgOptions::default(), Abs::pt(10.0));
        let incremental_edit_elapsed = start.elapsed();

        eprintln!(
            "M14 spike (persistent World): repeat compile of unchanged source: \
             {unedited_repeat_elapsed:?}; after Source::edit of one character: \
             {incremental_edit_elapsed:?}"
        );
    }

    /// Perf-baseline follow-up (plan.md): M14 above established that
    /// whole-doc recompile scales linearly with page count, but never varied
    /// *where* the edit lands, so it can't distinguish two different
    /// explanations for that linear cost: (a) cost tracks total document
    /// size regardless of edit position, or (b) cost tracks the amount of
    /// content *after* the edit point (plausible since Typst's pagination
    /// pass is sequential — a page break anywhere depends on cumulative
    /// height of everything before it, so an edit near the end has little
    /// downstream layout left to redo).
    ///
    /// Crosses two document lengths with three edit positions (near-start,
    /// middle, near-end) on the persistent-`World` + `Source::edit` path
    /// (the realistic per-keystroke architecture, unlike the fresh-`World`
    /// path which recompiles everything from scratch regardless of edit
    /// position by construction). If near-end edit cost stays roughly flat
    /// across the two document lengths while near-start/middle cost grows
    /// with length, that's direct evidence a bounded-window recompile
    /// (M16's undecided direction (a), phase3-single-view.md) is a real
    /// lever, not just a plausible-sounding idea. Prints all six
    /// measurements (`cargo test --release -- --nocapture`) since, as with
    /// M14, the point is the numbers themselves, not a pass/fail.
    #[test]
    fn recompile_latency_after_an_edit_depends_on_position_not_just_document_length() {
        use std::time::Instant;

        for sections in [14usize, 40usize] {
            let fixture = multi_page_fixture(sections);

            for (label, fraction) in [("near-start", 0.02), ("middle", 0.5), ("near-end", 0.98)] {
                let mut world = TauriWorld::new(fixture.clone(), None);

                // Warm up: pay the one-time font-scan/parse cost before
                // timing, same as M14's other benchmarks.
                typst::compile::<PagedDocument>(&world).output.expect("fixture must compile");

                // ASCII filler text throughout, so any byte offset is a
                // valid char boundary.
                let at = ((fixture.len() as f64) * fraction) as usize;
                world.edit_source(at..at, "x");

                let start = Instant::now();
                let edited = typst::compile::<PagedDocument>(&world)
                    .output
                    .expect("edited fixture must compile");
                let _ = typst_svg::svg_merged(&edited, &SvgOptions::default(), Abs::pt(10.0));
                let elapsed = start.elapsed();

                eprintln!(
                    "perf-baseline: {sections}-section fixture, edit at {label} \
                     (byte {at}/{}): {elapsed:?}",
                    fixture.len()
                );
            }
        }
    }

    #[test]
    fn diagnostics_resolve_correctly_past_cjk_text_on_earlier_lines() {
        // A regression guard for the earlier UTF-16/UTF-8 offset bug (see
        // src/util/offsets.ts): line/column here must come from typst-syntax's
        // own character-counting (Lines::byte_to_line_column), not from
        // anything that could conflate UTF-8 bytes with UTF-16 units.
        let result = compile_typst("= 一级标题\n\n#unknown_function()".into());
        assert_eq!(result.diagnostics.len(), 1);
        let diagnostic = &result.diagnostics[0];
        assert_eq!(diagnostic.line, Some(3), "message: {}", diagnostic.message);
        assert_eq!(diagnostic.column, Some(2), "message: {}", diagnostic.message);
    }
}
