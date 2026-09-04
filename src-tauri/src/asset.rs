//! `read_image_as_data_url` Tauri command (plan.md M11): resolves a
//! relative image path against the open document's directory and returns
//! its bytes as a base64 `data:` URL, for the WYSIWYG editing surface's
//! live `<img>` preview.
//!
//! Deliberately a narrowly-scoped Rust command rather than Tauri's asset
//! protocol (`convertFileSrc`): the asset protocol's access scope is a
//! *static* `tauri.conf.json` setting, and this app has no fixed project
//! root — the user can open a document from anywhere on disk (plan.md M7),
//! so there is no single directory to bake into that config ahead of time
//! short of a broad wildcard. A Rust command instead checks the *actual*
//! open document's directory on every call, via the same
//! `VirtualPath::realize`-based resolution `TauriWorld::file` (M11) already
//! uses for compilation — so this carries the identical `..`-escape-proof
//! guarantee, already covered by that module's tests. This only affects how
//! the WYSIWYG surface *displays* an image live; it has no bearing on
//! `compile_typst`/`export_pdf`, which read the real file directly through
//! `TauriWorld` regardless of how the editor renders its own preview.

use typst::syntax::VirtualPath;

fn guess_mime(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

#[tauri::command]
pub fn read_image_as_data_url(path: String, base_dir: String) -> Result<String, String> {
    let vpath = VirtualPath::new(&path).map_err(|err| err.to_string())?;
    let resolved =
        vpath.realize(std::path::Path::new(&base_dir)).map_err(|err| err.to_string())?;
    let bytes = std::fs::read(&resolved)
        .map_err(|err| format!("Failed to read {}: {err}", resolved.display()))?;
    let mime = guess_mime(&resolved);
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_real_file_and_returns_a_data_url() {
        let dir = std::env::temp_dir().join(format!("typst-editor-test-asset-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("photo.png"), b"pretend png bytes").unwrap();

        let url = read_image_as_data_url("photo.png".into(), dir.to_str().unwrap().into()).unwrap();
        assert!(url.starts_with("data:image/png;base64,"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_a_path_that_escapes_base_dir() {
        let root = std::env::temp_dir().join(format!("typst-editor-test-asset-escape-{}", std::process::id()));
        let base_dir = root.join("project");
        std::fs::create_dir_all(&base_dir).unwrap();
        std::fs::write(root.join("secret.png"), b"outside the sandbox").unwrap();

        let result =
            read_image_as_data_url("../secret.png".into(), base_dir.to_str().unwrap().into());
        assert!(result.is_err(), "expected the `..` escape to be rejected, got {result:?}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn errors_without_crashing_for_a_missing_file() {
        let dir = std::env::temp_dir().join(format!("typst-editor-test-asset-missing-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let result = read_image_as_data_url("nope.png".into(), dir.to_str().unwrap().into());
        assert!(result.is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
