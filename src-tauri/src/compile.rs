//! `compile_typst` Tauri command: takes raw Typst source, compiles it with
//! the real Typst engine, and returns a merged SVG preview plus diagnostics.

use std::path::PathBuf;

use serde::Serialize;
use typst::diag::{EcoVec, Severity, SourceDiagnostic};
use typst::layout::Abs;
use typst::{World, WorldExt};
use typst_layout::PagedDocument;
use typst_svg::SvgOptions;

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

/// `base_dir` (plan.md M11) is the open document's directory (`None` before
/// any file has been opened/saved), used to resolve `#image("path")` — see
/// `TauriWorld::file`. Threaded through from `App.tsx`'s `filePath` on every
/// compile, not just at load time, so editing/saving-as a document with
/// relative image paths always resolves against whatever is currently open.
#[tauri::command]
pub fn compile_typst(source: String, base_dir: Option<String>) -> CompileResult {
    let world = TauriWorld::new(source, base_dir.map(PathBuf::from));
    let warned = typst::compile::<PagedDocument>(&world);

    let mut diagnostics: Vec<CompileDiagnostic> =
        warned.warnings.iter().map(|d| to_diagnostic(&world, d)).collect();

    match warned.output {
        Ok(document) => {
            let svg = typst_svg::svg_merged(&document, &SvgOptions::default(), Abs::pt(10.0));
            CompileResult { svg: Some(svg), diagnostics }
        }
        Err(errors) => {
            diagnostics.extend(errors.iter().map(|d| to_diagnostic(&world, d)));
            CompileResult { svg: None, diagnostics }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shadows the outer 2-arg `compile_typst` for every existing test below —
    // none of them care about image-path resolution (plan.md M11), so this
    // avoids threading `, None` through every one of them individually.
    // `file_resolution` (below) exercises the real `base_dir`-aware command
    // directly via `super::compile_typst`.
    fn compile_typst(source: String) -> CompileResult {
        super::compile_typst(source, None)
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

        let result = super::compile_typst("#image(\"photo.png\")".into(), Some(dir.to_str().unwrap().into()));
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
            super::compile_typst("#image(\"nope.png\")".into(), Some(dir.to_str().unwrap().into()));
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

        let result = super::compile_typst(
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
