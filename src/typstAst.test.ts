import { describe, expect, it } from "vitest";
import { typstAstToDoc, pmDocToTypst } from "./typstAst";
import { fixtures } from "./typstAst.fixtures";
import { schema } from "./schema";

describe("typstAstToDoc / pmDocToTypst round trip", () => {
  it.each(Object.entries(fixtures))(
    "%s: ast -> PMDoc -> source matches the expected serialization",
    (_name, fixture) => {
      const doc = typstAstToDoc(fixture.ast);
      expect(() => doc.check()).not.toThrow();
      expect(pmDocToTypst(doc)).toBe(fixture.expected);
    },
  );

  it("carries top-level settings on doc.attrs, not interleaved in content", () => {
    const doc = typstAstToDoc(fixtures.typstSet.ast);
    expect(doc.attrs.settings).toEqual([{ function: "text", raw: "#set text(size: 11pt)" }]);
    doc.forEach((node) => {
      expect(node.type.name).not.toBe("typst_set");
    });
  });

  it("merges consecutive same-mark text runs into a single PM text node", () => {
    const doc = typstAstToDoc(fixtures.marks.ast);
    const paragraph = doc.child(0);
    // "bold" and " " and "italic" style pieces of *different* marks stay
    // distinct, but nothing here should end up as two adjacent PM text
    // nodes with identical marks (see typstAst.ts's inlineToNodes merge).
    for (let i = 1; i < paragraph.childCount; i++) {
      const prev = paragraph.child(i - 1);
      const curr = paragraph.child(i);
      if (prev.isText && curr.isText) {
        expect(prev.marks).not.toEqual(curr.marks);
      }
    }
  });

  it("builds a valid list_item even for an empty list item body", () => {
    const doc = typstAstToDoc({
      settings: [],
      content: [{ type: "bullet_list", items: [[]] }],
    });
    expect(() => doc.check()).not.toThrow();
    const item = doc.child(0).child(0);
    expect(item.childCount).toBe(1);
    expect(item.child(0).type).toBe(schema.nodes.paragraph);
  });

  it("escapes literal Typst markup characters in plain text", () => {
    const doc = typstAstToDoc({
      settings: [],
      content: [
        {
          type: "paragraph",
          children: [{ type: "text", text: "2 * 3 = 6, not #4", marks: [] }],
        },
      ],
    });
    expect(pmDocToTypst(doc)).toBe("2 \\* 3 = 6, not \\#4");
  });

  it("does not escape inside a code mark run", () => {
    const doc = typstAstToDoc({
      settings: [],
      content: [
        {
          type: "paragraph",
          children: [{ type: "text", text: "a*b_c", marks: ["code"] }],
        },
      ],
    });
    expect(pmDocToTypst(doc)).toBe("`a*b_c`");
  });
});
