// Pure, Tauri-free helpers for M7 file I/O (plan.md Phase 2). Kept separate
// from App.tsx so extension-based spoke selection and path display formatting
// are unit-testable without mocking the Tauri dialog/fs APIs.

export type Spoke = "typst" | "markdown";

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

/** Which spoke (Typst or Markdown) a file path's extension selects. Anything
 * that isn't a recognized Markdown extension (including `.typ` and unknown/
 * missing extensions) defaults to the Typst spoke. */
export function spokeForPath(path: string): Spoke {
  const match = /\.([^./\\]+)$/.exec(path);
  const ext = match?.[1]?.toLowerCase();
  return ext != null && MARKDOWN_EXTENSIONS.has(ext) ? "markdown" : "typst";
}

/** Default filename offered by the Save As dialog when no file is open yet. */
export function defaultFileName(spoke: Spoke): string {
  return spoke === "markdown" ? "untitled.md" : "untitled.typ";
}

/** Last path segment, handling both `/` and `\` separators (Windows paths
 * from the Tauri dialog use `\`). */
export function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

/** The open file's directory — the base `#image("relative/path")` paths
 * resolve against (plan.md M11) — or `null` before any file has been
 * opened/saved. Threaded to the Rust `base_dir` parameter on every
 * compile/export/asset-read call and to the WYSIWYG image NodeView. */
export function dirname(path: string | null): string | null {
  if (path == null) return null;
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  if (idx === -1) return null; // a bare filename carries no directory info
  return idx === 0 ? "/" : normalized.slice(0, idx);
}

/** The path from `fromDir` to `toFile`, Typst-style (forward slashes, `..`
 * for each level up) — used when inserting an image via the WYSIWYG file
 * picker (plan.md M11), since the Editor Model always stores `#image(...)`'s
 * `src` as a path relative to the open document's directory, never absolute.
 * Path segments are compared case-insensitively (matches this app's Windows
 * target — see README). */
export function relativePath(fromDir: string, toFile: string): string {
  const from = fromDir.replace(/\\/g, "/").split("/").filter(Boolean);
  const to = toFile.replace(/\\/g, "/").split("/").filter(Boolean);
  let shared = 0;
  while (
    shared < from.length &&
    shared < to.length &&
    from[shared].toLowerCase() === to[shared].toLowerCase()
  ) {
    shared += 1;
  }
  const ups = new Array(from.length - shared).fill("..");
  return [...ups, ...to.slice(shared)].join("/");
}

/** Title-bar label: filename plus a dirty marker, or "Untitled" before the
 * first save. */
export function titleFor(path: string | null, dirty: boolean): string {
  const name = path == null ? "Untitled" : basename(path);
  return dirty ? `${name} •` : name;
}

/** Default path offered by the PDF export Save dialog: same directory and
 * basename as the open file with its extension swapped to `.pdf`, or a
 * generic name when no file is open yet (plan.md M8). */
export function withPdfExtension(path: string | null): string {
  if (path == null) return "document.pdf";
  const normalized = path.replace(/\\/g, "/");
  const withoutExtension = normalized.replace(/\.[^./]+$/, "");
  return `${withoutExtension}.pdf`;
}
