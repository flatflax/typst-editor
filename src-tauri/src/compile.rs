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
    /// verbatim (src-tauri/src/ast.rs, src/typstAst.ts) only matters because
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

    #[test]
    fn diagnostics_resolve_correctly_past_cjk_text_on_earlier_lines() {
        // A regression guard for the earlier UTF-16/UTF-8 offset bug (see
        // src/offsets.ts): line/column here must come from typst-syntax's
        // own character-counting (Lines::byte_to_line_column), not from
        // anything that could conflate UTF-8 bytes with UTF-16 units.
        let result = compile_typst("= 一级标题\n\n#unknown_function()".into());
        assert_eq!(result.diagnostics.len(), 1);
        let diagnostic = &result.diagnostics[0];
        assert_eq!(diagnostic.line, Some(3), "message: {}", diagnostic.message);
        assert_eq!(diagnostic.column, Some(2), "message: {}", diagnostic.message);
    }
}
