//! `compile_typst` Tauri command: takes raw Typst source, compiles it with
//! the real Typst engine, and returns a merged SVG preview plus diagnostics.

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

#[tauri::command]
pub fn compile_typst(source: String) -> CompileResult {
    let world = TauriWorld::new(source);
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
