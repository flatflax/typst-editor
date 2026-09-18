// Phase 4 spikes (FocusRevealSpike2/3.tsx, doc/interaction-design.md §6) split
// a document into "blocks" wherever a blank line (`\n{2,}`) appears in the
// source, on the assumption that this matches Typst's own paragraph-break
// rule everywhere. Feel-testing that assumption directly against the real
// compiler (phase4-product-validation.md, 2026-09-10) found it only holds at
// the top level: a blank line inside a list item correctly ends it (matches
// this rule), but a blank line inside a table cell — or any other bracketed
// content, e.g. `#figure[...]`, a multi-line function argument — does *not*
// end anything, yet a plain `\n{2,}` regex would still cut there anyway,
// slicing straight through the middle of a `#table(...)` call. That produced
// a real, confirmed bug live: clicking into such a cell showed unrelated text
// from elsewhere in the document, because the resulting "block" wasn't a
// valid, addressable fragment of anything.
//
// The fix: only treat a blank line as a split point when it's not nested
// inside any bracket — `(`, `[`, or `{` (not distinguishing which type,
// since a working document never mismatches them, and a temporarily
// unbalanced one mid-edit is safer to under-count toward *more* splitting
// than to get stuck at a depth that never comes back to 0). String literals
// and single-backtick raw spans are skipped so bracket-like characters
// inside them don't affect the count; line/block comments are skipped too,
// since a comment like `// see [ref]` or `// TODO(later)` isn't real syntax.
// Known gap, not attempted here: triple-backtick raw *fences* (```` ```lang
// ... ``` ````) aren't tracked as a single span — a bracket typed inside a
// fenced code sample would still affect depth. Not hit by either of the two
// scenarios this was fact-checked against; worth revisiting if fenced code
// examples become common content.

import { utf16ToByteOffset } from "../util/offsets";

type ScanState = "normal" | "string" | "raw" | "line-comment" | "block-comment";

export function blockByteRanges(source: string): [number, number][] {
  const ranges: [number, number][] = [];
  const n = source.length;
  let lastEnd = 0;
  let depth = 0;
  let state: ScanState = "normal";
  let i = 0;

  while (i < n) {
    const ch = source[i];

    if (state === "string") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') state = "normal";
      i++;
      continue;
    }

    if (state === "raw") {
      if (ch === "`") state = "normal";
      i++;
      continue;
    }

    if (state === "line-comment") {
      if (ch === "\n") {
        state = "normal";
        continue; // reprocess this newline in "normal" state
      }
      i++;
      continue;
    }

    if (state === "block-comment") {
      if (ch === "*" && source[i + 1] === "/") {
        state = "normal";
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    // state === "normal"
    if (ch === '"') {
      state = "string";
      i++;
      continue;
    }
    if (ch === "`") {
      state = "raw";
      i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      state = "line-comment";
      i += 2;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      state = "block-comment";
      i += 2;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (depth === 0 && ch === "\n" && source[i + 1] === "\n") {
      const splitStart = i;
      let j = i;
      while (j < n && source[j] === "\n") j++;
      ranges.push([utf16ToByteOffset(source, lastEnd), utf16ToByteOffset(source, splitStart)]);
      lastEnd = j;
      i = j;
      continue;
    }
    i++;
  }

  ranges.push([utf16ToByteOffset(source, lastEnd), utf16ToByteOffset(source, source.length)]);
  return ranges;
}

export function blockAt(ranges: [number, number][], byteOffset: number): number | null {
  for (let i = 0; i < ranges.length; i++) {
    if (byteOffset >= ranges[i][0] && byteOffset <= ranges[i][1]) return i;
  }
  return null;
}

type ErrorDiagnostic = { severity: "error" | "warning"; range?: [number, number] };

// Which block should show the "compile failed" red placeholder (see
// interaction-design.md §10's "冻结上次编译成功的结果" decision). Typst's
// error-recovering parser doesn't always report a broken construct's span at
// the construct itself — recovery can swallow everything after the real
// mistake and report the span much later (even at EOF) — so a byte offset the
// caller *knows* was just edited (`lastEditByte`) is a more reliable signal
// than trusting the diagnostic's own span, when available. Falls back to the
// first error diagnostic with a resolvable range when there's no such offset
// (e.g. a file that was already broken before this session touched it).
export function selectErrorBlock(
  ranges: [number, number][],
  diagnostics: ErrorDiagnostic[],
  lastEditByte: number | null,
): number | null {
  if (!diagnostics.some((d) => d.severity === "error")) return null;

  if (lastEditByte != null) {
    const idx = blockAt(ranges, lastEditByte);
    if (idx != null) return idx;
  }

  for (const d of diagnostics) {
    if (d.severity !== "error" || !d.range) continue;
    const idx = blockAt(ranges, d.range[0]);
    if (idx != null) return idx;
  }

  return null;
}
