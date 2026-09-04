//! Minimal `typst::World` implementation for compiling a single, in-memory
//! Typst source string (no filesystem access, no imports) — enough to prove
//! the source -> compile -> render loop end to end (see plan.md, M0/M1).

use std::path::PathBuf;

use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::{FileId, Source};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};
use typst_kit::datetime::Time;
use typst_kit::fonts::FontStore;

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
