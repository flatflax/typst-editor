//! Minimal `typst::World` implementation for compiling a single, in-memory
//! Typst source string (no filesystem access, no imports) — enough to prove
//! the source -> compile -> render loop end to end (see plan.md, M0/M1).

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
/// fonts. Not tied to any file on disk.
pub struct TauriWorld {
    library: LazyHash<Library>,
    fonts: FontStore,
    source: Source,
    time: Time,
}

impl TauriWorld {
    pub fn new(text: String) -> Self {
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

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        let _ = id;
        Err(FileError::NotFound(PathBuf::from("<unsupported: file access is out of MVP scope>")))
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
    use typst::text::FontVariant;

    /// A font book with only Latin/math coverage can't render CJK text at
    /// all (no glyphs to fall back to); this pins the fix (system fonts
    /// merged into the book) rather than the SVG happening to look right on
    /// whatever machine runs the test.
    #[test]
    fn font_book_has_fallback_coverage_for_cjk_text() {
        let world = TauriWorld::new(String::new());
        let fallback =
            world.book().select_fallback(None, FontVariant::default(), "你好");
        assert!(
            fallback.is_some(),
            "no installed font covers CJK text — Chinese/Japanese/Korean will render blank"
        );
    }
}
