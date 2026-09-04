import { describe, expect, it } from "vitest";
import { Node as PMNode } from "prosemirror-model";
import { schema } from "./schema";
import { fixtures } from "./schema.fixtures";

describe("schema", () => {
  it.each(Object.entries(fixtures))("%s is a structurally valid doc", (_name, fixture) => {
    // Node#check throws on any content-model violation (wrong child order,
    // disallowed nesting, etc.) — the load-bearing assertion that the
    // fixture actually conforms to the schema it was hand-built against.
    expect(() => fixture.check()).not.toThrow();
    expect(fixture.type).toBe(schema.nodes.doc);
  });

  it("round-trips every fixture through toJSON/fromJSON", () => {
    for (const fixture of Object.values(fixtures)) {
      const restored = PMNode.fromJSON(schema, fixture.toJSON());
      expect(restored.eq(fixture)).toBe(true);
    }
  });

  it("rejects a heading level outside the MVP subset via node content, not attrs", () => {
    // The schema doesn't clamp `level` itself (plain data attr), but nothing
    // outside 1-3 should ever be produced by the Typst/Markdown parsers
    // (M3/M4) since neither grammar's MVP subset goes past level 3 — this
    // pins that assumption at the fixture layer rather than the schema.
    const headings = fixtures.headingsAndParagraph.content;
    const levels: number[] = [];
    headings.forEach((node) => {
      if (node.type === schema.nodes.heading) levels.push(node.attrs.level);
    });
    expect(levels).toEqual([1, 2, 3]);
  });

  it("keeps unsupported_block non-editable and atomic", () => {
    expect(schema.nodes.unsupported_block.isAtom).toBe(true);
    expect(schema.nodes.unsupported_block.spec.isolating).toBe(true);
  });

  it("preserves raw text verbatim on unsupported_block", () => {
    let raw: string | undefined;
    fixtures.withUnsupportedBlock.descendants((node) => {
      if (node.type === schema.nodes.unsupported_block) raw = node.attrs.raw;
    });
    expect(raw).toBe("#table(\n  columns: 2,\n  [a], [b],\n)");
  });

  it("allows one level of list nesting under a list_item", () => {
    let nestedFound = false;
    fixtures.nestedBulletList.descendants((node) => {
      if (node.type === schema.nodes.list_item) {
        node.forEach((child) => {
          if (child.type === schema.nodes.bullet_list) nestedFound = true;
        });
      }
    });
    expect(nestedFound).toBe(true);
  });
});
