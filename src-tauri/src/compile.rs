//! `compile_typst` Tauri command: takes raw Typst source, compiles it with
//! the real Typst engine, and returns a merged SVG preview plus diagnostics.

use serde::Serialize;
use typst::diag::{Severity, SourceDiagnostic};
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
