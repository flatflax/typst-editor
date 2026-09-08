// Exercises `applyStructuralCommand` (the pure half of structuralCommand.ts)
// against typstAst.fixtures.ts's existing pinned (source, AstDocument)
// pairs — same reason loop.test.ts does this rather than calling through
// `runStructuralCommand`'s `invoke("parse_typst_ast", ...)`: no Tauri IPC
// bridge in vitest.
import { describe, expect, it } from "vitest";
import { applyStructuralCommand } from "./structuralCommand";
import { typstAstToDoc } from "../spokes/typstAst";
import { liftList, setHeading, setParagraph, toggleBulletList, toggleOrderedList } from "./wysiwygCommands";
import { fixtures } from "../spokes/typstAst.fixtures";

describe("applyStructuralCommand", () => {
  it("toggles a paragraph into a heading, keeping the rest of the source untouched", () => {
    const doc = typstAstToDoc(fixtures.marks.ast);
    // Cursor mid-word ("bold"), well inside the paragraph — a structural
    // command shouldn't need an exact position, just one that resolves
    // somewhere inside the target block.
    const offset = fixtures.marks.source.indexOf("bold");
    const result = applyStructuralCommand(doc, offset, offset, setHeading(2));
    expect(result).not.toBeNull();
    expect(result!.source).toBe("== plain *bold* _italic_ `code` *_bold italic_*");
  });

  it("setParagraph on an existing heading demotes it back to a plain paragraph", () => {
    const doc = typstAstToDoc(fixtures.headings.ast);
    const offset = fixtures.headings.source.indexOf("Two");
    const result = applyStructuralCommand(doc, offset, offset, setParagraph);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("= One\n\nTwo\n\n=== Three");
  });

  it("wraps a paragraph in a bullet list", () => {
    const doc = typstAstToDoc(fixtures.marks.ast);
    const offset = 0;
    const result = applyStructuralCommand(doc, offset, offset, toggleBulletList);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("- plain *bold* _italic_ `code` *_bold italic_*");
  });

  it("toggleBulletList is a no-op (per wysiwygCommands.ts's own deliberate design) inside an existing bullet list", () => {
    const doc = typstAstToDoc(fixtures.nestedBulletList.ast);
    const offset = fixtures.nestedBulletList.source.indexOf("Apple");
    const result = applyStructuralCommand(doc, offset, offset, toggleBulletList);
    expect(result).toBeNull();
  });

  it("returns a cursor offset inside the transformed text, past the newly-prepended heading marker", () => {
    const doc = typstAstToDoc(fixtures.marks.ast);
    const offset = fixtures.marks.source.indexOf("bold");
    const result = applyStructuralCommand(doc, offset, offset, setHeading(1));
    expect(result).not.toBeNull();
    // "= " (2 bytes) was prepended ahead of the whole paragraph, so any
    // in-range cursor offset must now be at least 2.
    expect(result!.cursorOffset).toBeGreaterThanOrEqual(2);
    expect(result!.cursorOffset).toBeLessThanOrEqual(new TextEncoder().encode(result!.source).length);
  });

  it("toggleOrderedList wraps a paragraph in a numbered list, using Typst's \"+\" auto-number marker", () => {
    const doc = typstAstToDoc(fixtures.marks.ast);
    const result = applyStructuralCommand(doc, 0, 0, toggleOrderedList);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("+ plain *bold* _italic_ `code` *_bold italic_*");
  });

  // Characterizes what happens when a user wraps two *separately-typed*
  // sibling paragraphs into an ordered list one at a time (one toolbar
  // click per line) rather than selecting both first and wrapping once —
  // reported live as "every line became 1." `wysiwygCommands.ts`'s own
  // comment on `toggleList` already documents that PM's `wrapInList` does
  // not auto-merge into an adjacent list of the same type on a second,
  // separate wrap — this pins that as pre-existing PM behavior (present in
  // the original WYSIWYG toolbar too), not a regression introduced by
  // M23's parse -> transform -> serialize adapter.
  it("wrapping two sibling paragraphs into an ordered list one click at a time produces two separate one-item lists, not one two-item list", () => {
    const twoParagraphs = typstAstToDoc({
      settings: [],
      content: [
        { type: "paragraph", children: [{ type: "text", text: "line1", marks: [] }] },
        { type: "paragraph", children: [{ type: "text", text: "line2", marks: [] }] },
      ],
    });
    const first = applyStructuralCommand(twoParagraphs, 0, 0, toggleOrderedList);
    expect(first).not.toBeNull();
    expect(first!.source).toBe("+ line1\n\nline2");

    // Simulates the app's next click: re-parsing `first!.source` fresh
    // (no live Tauri IPC in vitest, so this hand-builds the AST that
    // `parse_typst_ast` would produce for it, matching orderedListDefault's
    // pinned parse behavior for a "+ " line).
    const reparsed = typstAstToDoc({
      settings: [],
      content: [
        {
          type: "ordered_list",
          start: 1,
          items: [[{ type: "paragraph", children: [{ type: "text", text: "line1", marks: [] }] }]],
        },
        { type: "paragraph", children: [{ type: "text", text: "line2", marks: [] }] },
      ],
    });
    const second = applyStructuralCommand(reparsed, "+ line1\n\n".length, "+ line1\n\n".length, toggleOrderedList);
    expect(second).not.toBeNull();
    expect(second!.source).toBe("+ line1\n\n+ line2");
  });

  // Characterizes another reported observation: clicking "P" on a list item
  // doesn't lift it back out into a plain paragraph. `setParagraph` is
  // `setBlockType(schema.nodes.paragraph)` (wysiwygCommands.ts:47) — it only
  // changes a textblock's own type/attrs, never its position in the tree, so
  // a list item's paragraph (already type `paragraph`) has nothing to
  // change and the command is a no-op. Lifting out of a list needs
  // `liftListItem` (Shift-Tab in the original keymap) instead — a
  // pre-existing, documented split in wysiwygCommands.ts (see `toggleList`'s
  // own comment on why the toolbar doesn't do this as a side effect), not
  // something this adapter changes.
  it("setParagraph on a list item's paragraph is a no-op — it does not lift the item out of its list", () => {
    const doc = typstAstToDoc({
      settings: [],
      content: [
        {
          type: "ordered_list",
          start: 1,
          items: [[{ type: "paragraph", children: [{ type: "text", text: "line1", marks: [] }] }]],
        },
      ],
    });
    const offset = "line1".length - 1;
    const result = applyStructuralCommand(doc, offset, offset, setParagraph);
    expect(result).toBeNull();
  });

  // The fix for the above, as actually composed by TypstLiveView.tsx's "P"
  // toolbar button: `liftList` first (escapes the list_item), then
  // `setParagraph` against *that* result (a no-op here, since lifting a
  // plain paragraph out already leaves it as type paragraph — but needed in
  // general, e.g. a list item whose primary content was a heading).
  it("liftList then setParagraph escapes a list item and lands as a plain paragraph", () => {
    const doc = typstAstToDoc({
      settings: [],
      content: [
        {
          type: "ordered_list",
          start: 1,
          items: [[{ type: "paragraph", children: [{ type: "text", text: "line1", marks: [] }] }]],
        },
      ],
    });
    const offset = "line1".length - 1;
    const lifted = applyStructuralCommand(doc, offset, offset, liftList);
    expect(lifted).not.toBeNull();
    expect(lifted!.source).toBe("line1");

    // Re-parsing "line1" alone gives a single top-level plain paragraph —
    // setParagraph on it is correctly a no-op (nothing left to change).
    const plainDoc = typstAstToDoc({
      settings: [],
      content: [{ type: "paragraph", children: [{ type: "text", text: "line1", marks: [] }] }],
    });
    const settled = applyStructuralCommand(plainDoc, lifted!.cursorOffset, lifted!.anchorOffset, setParagraph);
    expect(settled).toBeNull();
  });
});
