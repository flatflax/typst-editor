// Cross-spoke stability suite (plan.md M6: "Stabilize & prove the loop").
// M3/M4 already prove each spoke round-trips through *itself*
// (Typst -> model -> Typst, Markdown -> model -> Markdown); this file proves
// the thing the plan's Context section actually promises — that switching
// *between* spokes through the shared Editor Model doesn't corrupt content.
//
// Automatable half: doc -> Markdown -> doc survives structurally intact,
// checked here with the *real* remark parser (no cross-language split needed,
// same as markdown.test.ts). Also confirms both trips down to the *same*
// downstream Typst source, which is what actually gets compiled regardless
// of which view produced it.
//
// Not automatable here: leaving Typst *source* text requires the real
// `parse_typst_ast` Rust command (no Tauri IPC in unit tests, same
// limitation noted in typstAst.test.ts) — that leg of the WYSIWYG -> Typst
// -> Markdown -> WYSIWYG smoke checklist (plan.md M6) has to be run by hand
// in `tauri dev`.
import { describe, expect, it } from "vitest";
import { typstAstToDoc, pmDocToTypst } from "./typstAst";
import { docToMarkdown, markdownToDoc } from "./markdown";
import { fixtures } from "./typstAst.fixtures";
import type { PMDoc } from "./schema";

describe("Editor Model survives a round trip through Markdown", () => {
  it.each(Object.entries(fixtures))(
    "%s: doc -> Markdown -> doc is structurally unchanged",
    (_name, fixture) => {
      const doc = typstAstToDoc(fixture.ast);
      const roundTripped = markdownToDoc(docToMarkdown(doc));
      expect(roundTripped.eq(doc)).toBe(true);
    },
  );

  it.each(Object.entries(fixtures))(
    "%s: the Typst source compiled from the doc is unchanged after that round trip",
    (_name, fixture) => {
      const doc = typstAstToDoc(fixture.ast);
      const roundTripped = markdownToDoc(docToMarkdown(doc));
      // This is the property that actually matters for the preview: no
      // matter which view most recently touched the doc, the same content
      // must compile to the same Typst source.
      expect(pmDocToTypst(roundTripped)).toBe(pmDocToTypst(doc));
    },
  );
});

describe("full switcher cycle, the automatable half (plan.md M6 smoke checklist)", () => {
  it("WYSIWYG -> Markdown -> WYSIWYG preserves the mixed document end to end", () => {
    // "Author in WYSIWYG" = start from a PMDoc directly, exactly as
    // WysiwygEditor's live state already is one (src/WysiwygEditor.tsx).
    const authored: PMDoc = typstAstToDoc(fixtures.mixed.ast);

    // "Switch to Markdown" (App.tsx's switchView, the wysiwyg->markdown leg
    // — pure JS, no Rust round trip needed for this direction).
    const markdownText = docToMarkdown(authored);

    // "Switch back to WYSIWYG" (App.tsx's switchView, markdown->wysiwyg leg).
    const backInWysiwyg = markdownToDoc(markdownText);
    expect(backInWysiwyg.eq(authored)).toBe(true);

    // "Verify content and preview are unchanged": content already checked
    // above via structural equality; the preview is driven by pmDocToTypst,
    // so confirm that resolves to the identical Typst source too.
    expect(pmDocToTypst(backInWysiwyg)).toBe(pmDocToTypst(authored));

    // Switching to Markdown a second time from the round-tripped doc must
    // reproduce the exact same Markdown text — not a slowly-drifting
    // format, a fixed point.
    expect(docToMarkdown(backInWysiwyg)).toBe(markdownText);
  });
});
