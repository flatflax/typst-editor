//! `typst::World` implementation for compiling a single, in-memory Typst
//! source string (no multi-file imports) plus, since plan.md M11, real
//! (but narrowly scoped) filesystem access for resolving `#image(...)`
//! paths relative to the open document's directory — see `file()`.

use std::path::PathBuf;
use std::sync::LazyLock;

use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::{FileId, Source};
use typst::text::{Font, FontBook, FontInfo};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};
use typst_ide::IdeWorld;
use typst_kit::datetime::Time;
use typst_kit::fonts::{FontPath, FontStore};

/// System fonts, scanned once per process rather than on every compile
/// (`typst_kit::fonts::system()` walks OS font directories, which is too
/// slow to redo on every keystroke). `typst-kit`'s embedded fonts only cover
/// Latin text and math, so without this, CJK (and other non-Latin) text has
/// no glyphs to fall back to and renders blank/tofu. Font *bytes* still load
/// lazily per `TauriWorld` (cheap: OS page cache), only the metadata scan is
/// cached.
static SYSTEM_FONTS: LazyLock<Vec<(FontPath, FontInfo)>> =
    LazyLock::new(|| typst_kit::fonts::system().collect());

/// A `World` backed by a single detached source with the embedded Typst
/// fonts. `base_dir` (plan.md M11) — the open document's directory, or
/// `None` before any file has been opened/saved — is the *only* filesystem
/// root `file()` below will ever read from; there is deliberately no way to
/// reach any other directory (no multi-file imports, no `..` escape — see
/// `file()`'s doc comment).
pub struct TauriWorld {
    library: LazyHash<Library>,
    fonts: FontStore,
    source: Source,
    time: Time,
    base_dir: Option<PathBuf>,
}

impl TauriWorld {
    pub fn new(text: String, base_dir: Option<PathBuf>) -> Self {
        let mut fonts = FontStore::new();
        fonts.extend(typst_kit::fonts::embedded());
        fonts.extend(SYSTEM_FONTS.iter().map(|(path, info)| {
            (FontPath { path: path.path.clone(), index: path.index }, info.clone())
        }));

        Self {
            library: LazyHash::new(Library::default()),
            fonts,
            source: Source::detached(text),
            time: Time::system(),
            base_dir,
        }
    }
}

impl World for TauriWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        self.fonts.book()
    }

    fn main(&self) -> FileId {
        self.source.id()
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        if id == self.source.id() {
            Ok(self.source.clone())
        } else {
            Err(FileError::NotFound(PathBuf::from("<unsupported: multi-file projects are out of MVP scope>")))
        }
    }

    // Resolves an asset reference (currently only `#image("path")`, plan.md
    // M11) to bytes on disk, scoped to `base_dir` — the *only* filesystem
    // access this World grants. `VirtualPath::realize` (typst-syntax) is the
    // same path-resolution primitive `typst-cli`'s own `SystemWorld` uses: it
    // structurally rejects any path whose `..` segments would climb above
    // `base_dir` (returns `Err` rather than ever producing an escaped
    // `PathBuf`), so there is no manual ".." string-checking to get subtly
    // wrong here. No file is reachable at all before a document has been
    // opened/saved (`base_dir` is `None`).
    fn file(&self, id: FileId) -> FileResult<Bytes> {
        let base_dir = self.base_dir.as_deref().ok_or_else(|| {
            FileError::Other(Some("no open document directory to resolve this path against".into()))
        })?;
        let path = id.vpath().realize(base_dir).map_err(FileError::Realize)?;
        let bytes = std::fs::read(&path).map_err(|err| FileError::from_io(err, &path))?;
        Ok(Bytes::new(bytes))
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.font(index)
    }

    fn today(&self, offset: Option<Duration>) -> Option<Datetime> {
        self.time.today(offset)
    }
}

impl IdeWorld for TauriWorld {
    fn upcast(&self) -> &dyn World {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use typst::syntax::{RootedPath, VirtualPath, VirtualRoot};
    use typst::text::FontVariant;

    /// Same `FileId` shape `#image("relative/path")` resolves to at compile
    /// time — a project-root-relative virtual path, interned the same way
    /// `Source::detached`'s own main-file id is (see its doc comment).
    fn file_id(relative_path: &str) -> FileId {
        RootedPath::new(VirtualRoot::Project, VirtualPath::new(relative_path).unwrap()).intern()
    }

    #[test]
    fn file_reads_real_bytes_from_the_base_dir() {
        let dir = std::env::temp_dir().join(format!("typst-editor-test-world-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("photo.png"), b"not a real png, just bytes").unwrap();

        let world = TauriWorld::new(String::new(), Some(dir.clone()));
        let bytes = world.file(file_id("photo.png")).expect("expected the file to be found");
        assert_eq!(bytes.as_slice(), b"not a real png, just bytes");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_errors_without_crashing_when_no_document_is_open() {
        let world = TauriWorld::new(String::new(), None);
        assert!(world.file(file_id("photo.png")).is_err());
    }

    #[test]
    fn file_errors_without_crashing_for_a_missing_file() {
        let dir = std::env::temp_dir().join(format!("typst-editor-test-world-missing-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let world = TauriWorld::new(String::new(), Some(dir.clone()));
        assert!(world.file(file_id("does-not-exist.png")).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The security-critical guarantee (plan.md M11's explicit risk note)
    /// actually lives one layer *before* `TauriWorld::file` is ever called:
    /// `VirtualPath::new` rejects a `..`-escaping string outright (a
    /// `FileId` referencing one can't even be constructed), so `file()`
    /// itself can never be handed a virtual path that would climb above
    /// `base_dir` — confirmed directly here rather than assumed. See
    /// compile.rs's `image_path_escaping_base_dir_is_rejected_end_to_end`
    /// for the realistic, user-triggerable version of this same guarantee
    /// (a document with `#image("../secret.png")`, compiled for real).
    #[test]
    fn a_dot_dot_escaping_virtual_path_cannot_even_be_constructed() {
        assert!(VirtualPath::new("../secret.txt").is_err());
    }

    /// A font book with only Latin/math coverage can't render CJK text at
    /// all (no glyphs to fall back to); this pins the fix (system fonts
    /// merged into the book) rather than the SVG happening to look right on
    /// whatever machine runs the test.
    #[test]
    fn font_book_has_fallback_coverage_for_cjk_text() {
        let world = TauriWorld::new(String::new(), None);
        let fallback =
            world.book().select_fallback(None, FontVariant::default(), "你好");
        assert!(
            fallback.is_some(),
            "no installed font covers CJK text — Chinese/Japanese/Korean will render blank"
        );
    }
}
