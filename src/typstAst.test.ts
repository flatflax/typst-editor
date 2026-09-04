import { describe, expect, it } from "vitest";
import {
  typstAstToDoc,
  pmDocToTypst,
  pmDocToTypstWithPositions,
  pmPosToTypstOffset,
  typstOffsetToPmPos,
} from "./typstAst";
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

describe("pmDocToTypstWithPositions (plan.md M5)", () => {
  it.each(Object.entries(fixtures))(
    "%s: source matches pmDocToTypst and positions are internally consistent",
    (_name, fixture) => {
      const doc = typstAstToDoc(fixture.ast);
      const { source, positions } = pmDocToTypstWithPositions(doc);
      expect(source).toBe(pmDocToTypst(doc));

      // Sorted ascending in both keys simultaneously (see the doc comment on
      // pmPosToTypstOffset) — every breakpoint is a lookup fixed point in
      // both directions.
      for (let i = 1; i < positions.length; i++) {
        expect(positions[i].pm).toBeGreaterThanOrEqual(positions[i - 1].pm);
        expect(positions[i].typst).toBeGreaterThanOrEqual(positions[i - 1].typst);
      }
      for (const entry of positions) {
        expect(pmPosToTypstOffset(positions, entry.pm)).toBe(entry.typst);
        expect(typstOffsetToPmPos(positions, entry.typst)).toBe(entry.pm);
        expect(entry.typst).toBeGreaterThanOrEqual(0);
        expect(entry.typst).toBeLessThanOrEqual(source.length);
      }
    },
  );

  // Hand-verified against "= One\n\n== Two\n\n=== Three" (see typstAst.test.ts
  // git history / PR description for the by-hand index walk): each heading's
  // own PM position maps to where its "=" marker starts, and its text
  // child's PM position maps to where the heading text itself starts.
  it("maps PM positions to the exact byte offsets for a hand-verified fixture", () => {
    const doc = typstAstToDoc(fixtures.headings.ast);
    const { source, positions } = pmDocToTypstWithPositions(doc);
    expect(source).toBe("= One\n\n== Two\n\n=== Three");
    expect(positions).toEqual([
      { pm: 0, typst: 0 }, // heading 1 -> "="
      { pm: 1, typst: 2 }, // "One" -> "O"
      { pm: 5, typst: 7 }, // heading 2 -> "="
      { pm: 6, typst: 10 }, // "Two" -> "T"
      { pm: 10, typst: 15 }, // heading 3 -> "="
      { pm: 11, typst: 19 }, // "Three" -> "T"
    ]);
  });

  it("returns null for an empty position map and clamps out-of-range lookups", () => {
    const empty = typstAstToDoc({ settings: [], content: [] });
    const { positions } = pmDocToTypstWithPositions(empty);
    expect(positions).toEqual([]);
    expect(pmPosToTypstOffset(positions, 0)).toBeNull();
    expect(typstOffsetToPmPos(positions, 0)).toBeNull();

    const doc = typstAstToDoc(fixtures.headings.ast);
    const { positions: nonEmpty } = pmDocToTypstWithPositions(doc);
    // Before the first / after the last breakpoint clamps rather than
    // returning null — click/cursor sync should degrade gracefully to
    // "nearest known thing", never silently do nothing.
    expect(pmPosToTypstOffset(nonEmpty, -5)).toBe(nonEmpty[0].typst);
    expect(typstOffsetToPmPos(nonEmpty, 10_000)).toBe(nonEmpty[nonEmpty.length - 1].pm);
  });
});
