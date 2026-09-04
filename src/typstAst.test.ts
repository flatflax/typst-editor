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
      // pmPosToTypstOffset), each entry a valid non-negative, in-bounds
      // range. Looking a position up at an entry's *start* always recovers
      // that entry exactly — that's the tie-break `findEntry` guarantees.
      // The *end* boundary isn't guaranteed to round-trip the same way: a
      // PM position can be purely structural (e.g. "just entered this
      // paragraph, before any text") with no Typst character of its own,
      // so it can share a Typst offset with the *next* entry's start and
      // the reverse lookup will resolve to that next entry instead — not a
      // bug, just two PM positions mapping to one Typst offset.
      for (let i = 1; i < positions.length; i++) {
        expect(positions[i].pmFrom).toBeGreaterThanOrEqual(positions[i - 1].pmFrom);
        expect(positions[i].typstFrom).toBeGreaterThanOrEqual(positions[i - 1].typstFrom);
      }
      for (const entry of positions) {
        expect(entry.pmTo).toBeGreaterThanOrEqual(entry.pmFrom);
        expect(entry.typstTo).toBeGreaterThanOrEqual(entry.typstFrom);
        expect(entry.typstFrom).toBeGreaterThanOrEqual(0);
        expect(entry.typstTo).toBeLessThanOrEqual(source.length);
        expect(pmPosToTypstOffset(positions, entry.pmFrom)).toBe(entry.typstFrom);
        expect(typstOffsetToPmPos(positions, entry.typstFrom)).toBe(entry.pmFrom);
      }
    },
  );

  // Hand-verified against "= One\n\n== Two\n\n=== Three": each heading's own
  // PM position range [pos, pos+1) maps to its "= " marker, and its text
  // child's PM range maps to the heading text itself.
  it("maps PM positions to the exact byte offsets for a hand-verified fixture", () => {
    const doc = typstAstToDoc(fixtures.headings.ast);
    const { source, positions } = pmDocToTypstWithPositions(doc);
    expect(source).toBe("= One\n\n== Two\n\n=== Three");
    expect(positions).toEqual([
      { pmFrom: 0, pmTo: 1, typstFrom: 0, typstTo: 2 }, // heading 1 -> "= "
      { pmFrom: 1, pmTo: 4, typstFrom: 2, typstTo: 5 }, // "One" -> "One"
      { pmFrom: 5, pmTo: 6, typstFrom: 7, typstTo: 10 }, // heading 2 -> "== "
      { pmFrom: 6, pmTo: 9, typstFrom: 10, typstTo: 13 }, // "Two" -> "Two"
      { pmFrom: 10, pmTo: 11, typstFrom: 15, typstTo: 19 }, // heading 3 -> "=== "
      { pmFrom: 11, pmTo: 16, typstFrom: 19, typstTo: 24 }, // "Three" -> "Three"
    ]);

    // Interpolation within a range: the middle of "Three" (pm 13, 2 of 5
    // characters in) lands 2/5 of the way through its typst range too.
    expect(pmPosToTypstOffset(positions, 13)).toBe(19 + Math.round((2 / 5) * 5));
    expect(typstOffsetToPmPos(positions, 21)).toBe(11 + Math.round((2 / 5) * 5));
  });

  it("returns null for an empty position map and clamps out-of-range lookups", () => {
    const empty = typstAstToDoc({ settings: [], content: [] });
    const { positions } = pmDocToTypstWithPositions(empty);
    expect(positions).toEqual([]);
    expect(pmPosToTypstOffset(positions, 0)).toBeNull();
    expect(typstOffsetToPmPos(positions, 0)).toBeNull();

    const doc = typstAstToDoc(fixtures.headings.ast);
    const { positions: nonEmpty } = pmDocToTypstWithPositions(doc);
    // Before the first / after the last entry clamps rather than returning
    // null — click/cursor sync should degrade gracefully to "nearest known
    // thing", never silently do nothing.
    expect(pmPosToTypstOffset(nonEmpty, -5)).toBe(nonEmpty[0].typstFrom);
    expect(typstOffsetToPmPos(nonEmpty, 10_000)).toBe(nonEmpty[nonEmpty.length - 1].pmTo);
  });

  it("interpolates a click landing mid-run to a nearby WYSIWYG position, not the run's start", () => {
    // Regression guard for the imprecision a user reported after trying M5:
    // clicking mid-paragraph in the preview was landing the WYSIWYG cursor
    // at the *start* of the whole paragraph, because the original position
    // map recorded one point per run instead of a range to interpolate in.
    const doc = typstAstToDoc(fixtures.marks.ast);
    const { source, positions } = pmDocToTypstWithPositions(doc);
    // "plain *bold* _italic_ `code` *_bold italic_*" — click in the middle
    // of "plain" (a 5-character run starting at typst offset 0).
    const middleOfPlain = 2;
    const pmPos = typstOffsetToPmPos(positions, middleOfPlain);
    expect(pmPos).not.toBeNull();
    // The run's PM range is [1, 6) (paragraph content starts at pos 1); a
    // click 2/5 into "plain" should land near pos 3, not snap to pos 1.
    expect(pmPos).toBe(3);
    expect(source.slice(0, 5)).toBe("plain");
  });
});
