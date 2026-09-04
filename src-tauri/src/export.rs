//! `export_pdf` Tauri command (plan.md M8): compiles Typst source through
//! the same `TauriWorld`/`PagedDocument` pipeline `compile_typst` already
//! uses for the live SVG preview, exports the result to PDF via
//! `typst_pdf::pdf`, and writes the bytes to `path` directly (no separate
//! frontend fs round-trip needed for the binary PDF data).

use std::path::PathBuf;

use typst_layout::PagedDocument;
use typst_pdf::PdfOptions;

use crate::compile::diagnostics_to_string;
use crate::typst_world::TauriWorld;

/// `base_dir` (plan.md M11): see `compile_typst`'s doc comment — an exported
/// PDF containing an `#image(...)` needs the same open-document directory to
/// resolve it against, or the export fails with a compile error instead of
/// silently omitting the image.
#[tauri::command]
pub fn export_pdf(source: String, path: String, base_dir: Option<String>) -> Result<(), String> {
    let world = TauriWorld::new(source, base_dir.map(PathBuf::from));
    let warned = typst::compile::<PagedDocument>(&world);
    let document = warned.output.map_err(|errors| diagnostics_to_string(&world, &errors))?;

    let bytes = typst_pdf::pdf(&document, &PdfOptions::default())
        .map_err(|errors| diagnostics_to_string(&world, &errors))?;

    std::fs::write(&path, bytes).map_err(|err| format!("Failed to write {path}: {err}"))
}

#[cfg(test)]
mod tests {
    // Shadows the outer 3-arg command — these tests don't exercise
    // image-path resolution (plan.md M11), same approach as compile.rs.
    fn export_pdf(source: String, path: String) -> Result<(), String> {
        super::export_pdf(source, path, None)
    }

    #[test]
    fn exports_valid_source_to_a_pdf_file_starting_with_the_pdf_magic_bytes() {
        let dir = std::env::temp_dir().join(format!("typst-editor-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("export_valid.pdf");

        let result = export_pdf(
            "= Hello\n\nThis is *bold* and _italic_.".into(),
            path.to_str().unwrap().into(),
        );
        assert!(result.is_ok(), "expected export to succeed: {result:?}");

        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.starts_with(b"%PDF-"), "expected a PDF file, got {:?}", &bytes[..bytes.len().min(16)]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reports_compile_errors_instead_of_writing_a_file() {
        let dir = std::env::temp_dir().join(format!("typst-editor-test-{}-err", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("should_not_exist.pdf");

        let result = export_pdf("#unknown_function()".into(), path.to_str().unwrap().into());
        assert!(result.is_err());
        assert!(!path.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
