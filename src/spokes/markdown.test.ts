import { describe, expect, it } from "vitest";
import { docToMarkdown, markdownToDoc } from "./markdown";
import { pmDocToTypst } from "./typstAst";
import { schema } from "../model/schema";

// Unlike the Typst spoke (typstAst.test.ts), remark runs in this process —
// there's no cross-language boundary to split around — so these fixtures
// exercise the real remark-parse/-stringify pipeline end to end: parse the
// source, map to a PMDoc, serialize back, and re-parse. "Stability" (plan.md
// M4) means the second generation is structurally identical to the first,
// not that the regenerated text is byte-for-byte the original — remark
// normalizes some formatting (e.g. emphasis markers), which is fine as long
// as it's a fixed point.
function assertStableRoundTrip(source: string) {
  const doc1 = markdownToDoc(source);
  expect(() => doc1.check()).not.toThrow();
  const regenerated = docToMarkdown(doc1);
  const doc2 = markdownToDoc(regenerated);
  expect(doc2.eq(doc1)).toBe(true);
  return { doc: doc1, regenerated };
}

describe("markdown round trip", () => {
  it("headings 1-3 and a paragraph survive verbatim", () => {
    const { regenerated } = assertStableRoundTrip("# One\n\n## Two\n\n### Three\n\nBody text.");
    expect(regenerated).toBe("# One\n\n## Two\n\n### Three\n\nBody text.");
  });

  it("heading level 4+ is outside the MVP subset", () => {
    const { doc } = assertStableRoundTrip("#### Too deep");
    expect(doc.child(0).type).toBe(schema.nodes.unsupported_block);
    expect(doc.child(0).attrs.raw).toBe("#### Too deep");
  });

  it("carries strong/em/code marks, canonicalizing markers", () => {
    const { doc, regenerated } = assertStableRoundTrip(
      "plain **bold** _italic_ `code` **_bold italic_**",
    );
    expect(regenerated).toBe("plain **bold** _italic_ `code` **_bold italic_**");
    const paragraph = doc.child(0);
    const marksOf = (i: number) => paragraph.child(i).marks.map((m) => m.type.name);
    expect(marksOf(0)).toEqual([]); // "plain "
    expect(marksOf(1)).toEqual(["strong"]); // "bold"
    expect(marksOf(3)).toEqual(["em"]); // "italic"
    expect(marksOf(5)).toEqual(["code"]); // "code"
  });

  it("hard line breaks are preserved", () => {
    const { doc } = assertStableRoundTrip("line one  \nline two");
    const paragraph = doc.child(0);
    const kinds: string[] = [];
    paragraph.forEach((n) => kinds.push(n.isText ? "text" : n.type.name));
    expect(kinds).toEqual(["text", "hard_break", "text"]);
  });

  it("nested bullet lists match the source structure", () => {
    const { doc, regenerated } = assertStableRoundTrip(
      "- Apple\n- Banana\n  - Sub item\n  - Another sub item\n- Orange",
    );
    expect(regenerated).toBe("- Apple\n- Banana\n  - Sub item\n  - Another sub item\n- Orange");
    const list = doc.child(0);
    expect(list.type).toBe(schema.nodes.bullet_list);
    expect(list.childCount).toBe(3);
    const banana = list.child(1);
    expect(banana.childCount).toBe(2);
    expect(banana.child(1).type).toBe(schema.nodes.bullet_list);
  });

  it("ordered lists default to start 1 and preserve an explicit start", () => {
    const defaultStart = assertStableRoundTrip("1. First\n2. Second").doc;
    expect(defaultStart.child(0).attrs.order).toBe(1);

    const explicitStart = assertStableRoundTrip("5. Fifth\n6. Sixth");
    expect(explicitStart.doc.child(0).attrs.order).toBe(5);
    expect(explicitStart.regenerated).toBe("5. Fifth\n6. Sixth");
  });

  it("a fenced typst-call block round-trips into a block typst_call node", () => {
    const { doc, regenerated } = assertStableRoundTrip("```typst-call\n#line(length: 100%)\n```");
    const call = doc.child(0);
    expect(call.type).toBe(schema.nodes.typst_call);
    expect(call.attrs).toEqual({ name: "line", raw: "#line(length: 100%)" });
    expect(regenerated).toBe("```typst-call\n#line(length: 100%)\n```");
  });

  it("inline code starting with # round-trips into an inline typst_call chip", () => {
    const { doc, regenerated } = assertStableRoundTrip("Inline `#emph[call]` here.");
    const paragraph = doc.child(0);
    let found: { name: string; raw: string } | undefined;
    paragraph.forEach((n) => {
      if (n.type === schema.nodes.typst_call_inline) found = n.attrs as { name: string; raw: string };
    });
    expect(found).toEqual({ name: "emph", raw: "#emph[call]" });
    expect(regenerated).toBe("Inline `#emph[call]` here.");
  });

  it("a top-level typst-set fence is lifted into doc.attrs.settings", () => {
    const { doc, regenerated } = assertStableRoundTrip(
      "```typst-set\n#set text(size: 11pt)\n```\n\n# Heading",
    );
    expect(doc.attrs.settings).toEqual([{ function: "text", raw: "#set text(size: 11pt)" }]);
    doc.forEach((node) => expect(node.type.name).not.toBe("code"));
    expect(regenerated).toBe("```typst-set\n#set text(size: 11pt)\n```\n\n# Heading");
  });

  it("a blockquote is outside the MVP subset and falls back to unsupported_block", () => {
    const { doc, regenerated } = assertStableRoundTrip("Before.\n\n> quoted\n\nAfter.");
    expect(doc.child(1).type).toBe(schema.nodes.unsupported_block);
    expect(doc.child(1).attrs.raw).toBe("> quoted");
    // Re-emitted as a ```typst-raw``` fence (not the original blockquote
    // syntax verbatim) — deliberately: see markdown.ts's header comment on
    // why unsupported_block can't just pass its raw text through as plain
    // text (arbitrary content can silently reparse as an ordinary supported
    // paragraph instead of staying flagged opaque). Still recognized as the
    // same unsupported_block on the next parse, which is what "stable"
    // means here — assertStableRoundTrip already checked that above.
    expect(regenerated).toBe("Before.\n\n```typst-raw\n> quoted\n```\n\nAfter.");
  });

  it("a fenced code block without our special lang tags is unsupported", () => {
    const { doc } = assertStableRoundTrip("```rust\nfn main() {}\n```");
    expect(doc.child(0).type).toBe(schema.nodes.unsupported_block);
    expect(doc.child(0).attrs.raw).toBe("```rust\nfn main() {}\n```");
  });

  // plan.md M9: a link is a mark (reusing the strong/em/code mark
  // infrastructure), not a node — so unlike the pre-M9 behavior (a link used
  // to demote its whole containing paragraph to unsupported_block), it now
  // round-trips as real, editable content.
  it("a link round-trips into a link mark, not unsupported_block", () => {
    const { doc, regenerated } = assertStableRoundTrip("See [here](https://example.com) now.");
    expect(regenerated).toBe("See [here](https://example.com) now.");
    const paragraph = doc.child(0);
    let found: { href: string; text: string } | undefined;
    paragraph.forEach((n) => {
      const link = n.marks.find((m) => m.type.name === "link");
      if (link) found = { href: link.attrs.href as string, text: n.text ?? "" };
    });
    expect(found).toEqual({ href: "https://example.com", text: "here" });
  });

  // Confirms mark-stacking survives the Markdown spoke too (plan.md M9:
  // "including a link inside other marks (bold link)") — mirrors
  // typstAst.fixtures.ts's linkWithBoldText on the Typst side.
  it("a bold link keeps both the strong and link marks", () => {
    const { doc, regenerated } = assertStableRoundTrip("[**Typst**](https://typst.app)");
    expect(regenerated).toBe("[**Typst**](https://typst.app)");
    const run = doc.child(0).child(0);
    const markNames = run.marks.map((m) => m.type.name).sort();
    expect(markNames).toEqual(["link", "strong"]);
    expect(run.marks.find((m) => m.type.name === "link")?.attrs.href).toBe("https://typst.app");
  });

  // plan.md M4 asks for a compile-diff proof that content authored via
  // Markdown reaches the real Typst compiler unchanged. There's no bridge
  // from vitest into the real Rust compiler (same limitation noted in
  // typstAst.test.ts), so this instead chains into pmDocToTypst (M3) — which
  // *is* separately proven to compile with real visual effect in
  // src-tauri/src/compile.rs's set_rule_settings_have_a_real_visual_effect
  // test — to show the Markdown-authored #set/typst_call survive all the
  // way to the exact same Typst source that test already compiles.
  it("markdown-authored #set and typst_call reach pmDocToTypst unchanged", () => {
    const doc = markdownToDoc(
      "```typst-set\n#set text(size: 30pt)\n```\n\n# Heading\n\n```typst-call\n#line(length: 100%)\n```",
    );
    expect(pmDocToTypst(doc)).toBe(
      "#set text(size: 30pt)\n\n= Heading\n\n#line(length: 100%)",
    );
  });

  // Same cross-spoke proof as the #set/typst_call test above, for a link.
  it("a markdown-authored link reaches pmDocToTypst as a real #link(...) call", () => {
    const doc = markdownToDoc("See [the docs](https://typst.app) for more.");
    expect(pmDocToTypst(doc)).toBe('See #link("https://typst.app")[the docs] for more.');
  });

  describe("images (plan.md M11)", () => {
    it("an uncaptioned image round-trips through markdown", () => {
      const { doc, regenerated } = assertStableRoundTrip("![](photo.png)");
      const image = doc.child(0);
      expect(image.type).toBe(schema.nodes.image);
      expect(image.attrs).toEqual({ src: "photo.png", caption: null });
      expect(regenerated).toBe("![](photo.png)");
    });

    // A captioned Typst figure round-trips as the image's alt text (plan.md
    // M11's documented, accepted lossy-but-stable mapping).
    it("alt text round-trips as the image's caption", () => {
      const { doc, regenerated } = assertStableRoundTrip("![A nice photo](photo.png)");
      const image = doc.child(0);
      expect(image.attrs).toEqual({ src: "photo.png", caption: "A nice photo" });
      expect(regenerated).toBe("![A nice photo](photo.png)");
    });

    it("a markdown-authored captioned image reaches pmDocToTypst as a real #figure(...) call", () => {
      const doc = markdownToDoc("![A nice photo](photo.png)");
      expect(pmDocToTypst(doc)).toBe('#figure(image("photo.png"), caption: [A nice photo])');
    });

    it("a markdown-authored uncaptioned image reaches pmDocToTypst as a bare #image(...) call", () => {
      const doc = markdownToDoc("![](photo.png)");
      expect(pmDocToTypst(doc)).toBe('#image("photo.png")');
    });
  });

  describe("tables (plan.md M10)", () => {
    it("a table round-trips through GFM markdown", () => {
      const { doc, regenerated } = assertStableRoundTrip("| A | B |\n| --- | --- |\n| 1 | 2 |");
      const table = doc.child(0);
      expect(table.type).toBe(schema.nodes.table);
      expect(table.childCount).toBe(2); // 2 rows
      expect(table.child(0).childCount).toBe(2); // 2 cells per row
      expect(regenerated).toContain("| A | B |");
    });

    it("mixed inline marks in a cell survive the round trip", () => {
      const { doc } = assertStableRoundTrip("| **Bold** | *Italic* |\n| --- | --- |\n| x | y |");
      const firstCell = doc.child(0).child(0).child(0); // table > row 0 > cell 0
      const paragraph = firstCell.child(0);
      expect(paragraph.child(0).marks.map((m) => m.type.name)).toEqual(["strong"]);
    });

    it("a markdown-authored table reaches pmDocToTypst as a real #table(...) call", () => {
      const doc = markdownToDoc("| A | B |\n| --- | --- |\n| 1 | 2 |");
      expect(pmDocToTypst(doc)).toBe("#table(columns: 2, [A], [B], [1], [2])");
    });

    // plan.md M10: "one that exercises the Markdown-side block-content
    // fallback" — a table cell containing block content (a heading, here)
    // isn't something GFM pipe tables can express at all (there's no
    // markdown syntax that could even parse into this shape), so this is
    // authored directly as a PMDoc (as WYSIWYG editing would produce), not
    // parsed from markdown text.
    it("a table cell with block content falls back to an opaque fence, not corruption", () => {
      const cellWithHeading = schema.nodes.table_cell.create(null, [
        schema.nodes.heading.create({ level: 2 }, [schema.text("Section")]),
      ]);
      const plainCell = schema.nodes.table_cell.create(null, [
        schema.nodes.paragraph.create(null, [schema.text("plain")]),
      ]);
      const table = schema.nodes.table.create({ columnsRaw: "2", columnCount: 2 }, [
        schema.nodes.table_row.create(null, [cellWithHeading, plainCell]),
      ]);
      const doc = schema.nodes.doc.create({ settings: [] }, [table]);

      const markdown = docToMarkdown(doc);
      expect(markdown).toContain("```typst-raw");
      expect(markdown).toContain("#table(");
      expect(markdown).toContain("Section");

      const roundTripped = markdownToDoc(markdown);
      expect(roundTripped.child(0).type).toBe(schema.nodes.unsupported_block);
      // Still the same compiled Typst source either way — the whole point
      // of the opaque-fence policy (see this file's header comment).
      expect(pmDocToTypst(roundTripped)).toBe(pmDocToTypst(doc));
    });
  });

  it("a multi-paragraph list item collapses to a single unsupported_block for that item", () => {
    const source = "- First paragraph.\n\n  Second paragraph.\n- Second item.";
    const doc = markdownToDoc(source);
    expect(() => doc.check()).not.toThrow();
    const firstItem = doc.child(0).child(0);
    expect(firstItem.childCount).toBe(1);
    expect(firstItem.child(0).type).toBe(schema.nodes.unsupported_block);
  });

  // Every MVP construct in one document (plan.md M6: "extend M3/M4 fixtures
  // to cover mixed content and at least one unsupported_block case") — the
  // Markdown-side counterpart to ast.rs's MIXED_DOCUMENT.
  it("a mixed document combining every construct round-trips stably", () => {
    const source =
      "```typst-set\n#set text(size: 11pt)\n```\n\n" +
      "# Report\n\n" +
      "Some **bold** and _italic_ and `code` text.\n\n" +
      "- Apple\n- Banana\n  - Nested one\n  - Nested two\n\n" +
      "1. Step one\n2. Step two\n\n" +
      "```typst-call\n#line(length: 100%)\n```\n\n" +
      "Inline call: `#emph[hi]` here.\n\n" +
      "> A blockquote, outside the MVP subset.";
    const { doc } = assertStableRoundTrip(source);

    expect(doc.attrs.settings).toEqual([{ function: "text", raw: "#set text(size: 11pt)" }]);
    expect(doc.child(0).type).toBe(schema.nodes.heading);
    expect(doc.child(1).type).toBe(schema.nodes.paragraph);
    expect(doc.child(2).type).toBe(schema.nodes.bullet_list);
    expect(doc.child(3).type).toBe(schema.nodes.ordered_list);
    expect(doc.child(4).type).toBe(schema.nodes.typst_call);
    let hasInlineCall = false;
    doc.child(5).forEach((n) => {
      if (n.type === schema.nodes.typst_call_inline) hasInlineCall = true;
    });
    expect(hasInlineCall).toBe(true);
    expect(doc.child(6).type).toBe(schema.nodes.unsupported_block);

    // Reaches the same downstream Typst source the compile-diff proof in
    // ast::tests::mixed_document_compiles_successfully already compiles.
    expect(pmDocToTypst(doc)).toBe(
      "#set text(size: 11pt)\n\n= Report\n\nSome *bold* and _italic_ and `code` text." +
        "\n\n- Apple\n- Banana\n  - Nested one\n  - Nested two\n\n1. Step one\n2. Step two" +
        "\n\n#line(length: 100%)\n\nInline call: #emph[hi] here." +
        "\n\n> A blockquote, outside the MVP subset.",
    );
  });
});
