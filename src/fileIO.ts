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

/** Title-bar label: filename plus a dirty marker, or "Untitled" before the
 * first save. */
export function titleFor(path: string | null, dirty: boolean): string {
  const name = path == null ? "Untitled" : basename(path);
  return dirty ? `${name} •` : name;
}
