import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { splitListItem } from "prosemirror-schema-list";
import { schema } from "./schema";
import { pmDocToTypst } from "./typstAst";
import {
  insertTable,
  liftList,
  setHeading,
  setParagraph,
  sinkList,
  toggleBulletList,
  toggleCode,
  toggleEm,
  toggleLink,
  toggleOrderedList,
  toggleStrong,
} from "./wysiwygCommands";

// prosemirror-state/-commands are pure and DOM-free, so these run headlessly
// (no EditorView / jsdom needed) — mirrors how SourceEditor.tsx has no
// component-level test, but the logic it depends on is covered elsewhere.
function applyCommand(state: EditorState, command: (typeof toggleStrong)) {
  let next = state;
  const applied = command(state, (tr) => {
    next = state.apply(tr);
  });
  return { applied, state: next };
}

function textPosition(doc: ReturnType<typeof schema.node>, text: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (node.isText && node.text === text) found = pos;
  });
  if (found < 0) throw new Error(`no text node ${JSON.stringify(text)} found`);
  return found;
}

const splitListItemCommand = splitListItem(schema.nodes.list_item);

function docWithHello(): ReturnType<typeof schema.node> {
  return schema.node("doc", { settings: [] }, [schema.node("paragraph", null, [schema.text("hello")])]);
}

describe("mark toggles", () => {
  it("toggleStrong applies then removes the mark on the selected range", () => {
    const doc = schema.node("doc", { settings: [] }, [
      schema.node("paragraph", null, [schema.text("hello")]),
    ]);
    let state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 1, 6) });

    let result = applyCommand(state, toggleStrong);
    expect(result.applied).toBe(true);
    state = result.state;
    expect(state.doc.child(0).child(0).marks.map((m) => m.type.name)).toEqual(["strong"]);

    result = applyCommand(state, toggleStrong);
    state = result.state;
    expect(state.doc.child(0).child(0).marks).toEqual([]);
  });

  it("toggleEm and toggleCode target their own marks independently", () => {
    const doc = schema.node("doc", { settings: [] }, [
      schema.node("paragraph", null, [schema.text("hello")]),
    ]);
    let state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 1, 6) });
    state = applyCommand(state, toggleEm).state;
    state = applyCommand(state, toggleCode).state;
    expect(state.doc.child(0).child(0).marks.map((m) => m.type.name).sort()).toEqual([
      "code",
      "em",
    ]);
  });
});

describe("toggleLink (plan.md M9)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is a no-op on an empty (collapsed) selection", () => {
    const doc = docWithHello();
    const state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 1, 1) });
    const result = applyCommand(state, toggleLink);
    expect(result.applied).toBe(false);
    expect(result.state.doc.eq(doc)).toBe(true);
  });

  it("prompts for a URL and applies the link mark to the selection", () => {
    vi.stubGlobal("window", { prompt: vi.fn(() => "https://example.com") });
    const doc = docWithHello();
    const state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 1, 6) });

    const result = applyCommand(state, toggleLink);
    expect(result.applied).toBe(true);
    const link = result.state.doc.child(0).child(0).marks.find((m) => m.type.name === "link");
    expect(link?.attrs.href).toBe("https://example.com");
    expect(pmDocToTypst(result.state.doc)).toBe('#link("https://example.com")[hello]');
  });

  it("does nothing if the URL prompt is cancelled (returns null)", () => {
    vi.stubGlobal("window", { prompt: vi.fn(() => null) });
    const doc = docWithHello();
    const state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 1, 6) });

    const result = applyCommand(state, toggleLink);
    expect(result.applied).toBe(false);
    expect(result.state.doc.eq(doc)).toBe(true);
  });

  it("removes the link mark (no reprompt) when the selection is already linked", () => {
    const linked = schema.node("doc", { settings: [] }, [
      schema.node("paragraph", null, [
        schema.text("hello", [schema.marks.link.create({ href: "https://example.com" })]),
      ]),
    ]);
    const state = EditorState.create({
      schema,
      doc: linked,
      selection: TextSelection.create(linked, 1, 6),
    });

    const result = applyCommand(state, toggleLink);
    expect(result.applied).toBe(true);
    expect(result.state.doc.child(0).child(0).marks).toEqual([]);
  });
});

describe("insertTable (plan.md M10)", () => {
  it("inserts a well-formed rows x cols table at the cursor", () => {
    const doc = docWithHello();
    // Cursor at the *end* of "hello" — the table lands after it, matching
    // the intuitive "type text, then insert a table" usage.
    const state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 6, 6) });

    const result = applyCommand(state, insertTable(2, 3));
    expect(result.applied).toBe(true);
    expect(() => result.state.doc.check()).not.toThrow();

    const table = result.state.doc.child(1);
    expect(table.type).toBe(schema.nodes.table);
    expect(table.attrs).toEqual({ columnsRaw: "3", columnCount: 3 });
    expect(table.childCount).toBe(2); // rows
    table.forEach((row) => expect(row.childCount).toBe(3)); // cells per row
    expect(pmDocToTypst(result.state.doc)).toBe(
      "hello\n\n#table(columns: 3, [], [], [], [], [], [])",
    );
  });
});

describe("block type commands", () => {
  it("setHeading changes a paragraph into a heading at the given level", () => {
    const doc = schema.node("doc", { settings: [] }, [
      schema.node("paragraph", null, [schema.text("hello")]),
    ]);
    const state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 1, 1) });
    const { state: next } = applyCommand(state, setHeading(2));
    expect(next.doc.child(0).type).toBe(schema.nodes.heading);
    expect(next.doc.child(0).attrs.level).toBe(2);
  });

  it("setParagraph changes a heading back into a paragraph", () => {
    const doc = schema.node("doc", { settings: [] }, [
      schema.node("heading", { level: 3 }, [schema.text("hello")]),
    ]);
    const state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 1, 1) });
    const { state: next } = applyCommand(state, setParagraph);
    expect(next.doc.child(0).type).toBe(schema.nodes.paragraph);
  });
});

describe("list toggling", () => {
  it("toggleBulletList wraps a paragraph into a list", () => {
    const doc = schema.node("doc", { settings: [] }, [
      schema.node("paragraph", null, [schema.text("hello")]),
    ]);
    const state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 1, 1) });

    const result = applyCommand(state, toggleBulletList);
    expect(result.applied).toBe(true);
    expect(result.state.doc.child(0).type).toBe(schema.nodes.bullet_list);
    expect(result.state.doc.child(0).child(0).type).toBe(schema.nodes.list_item);
  });

  // Regression guard for a second, related user-reported bug: after the
  // splitListItem/Enter fix above, clicking the *same* list-type toolbar
  // button again while already inside that list type used to lift the
  // current item back out (the conventional toggle-off behavior) — a real
  // trap once Enter already continues the list on its own, since a user
  // re-clicking the button per new line (out of habit, or not realizing
  // Enter already worked) would unknowingly un-list the item they just
  // typed. Confirmed live: node1 <toolbar> Enter node2 <toolbar again>
  // Enter node3 <toolbar again> produced
  // <ol><li>b1</li></ol><p>b2</p><ol><li>b3</li></ol> — three lists, not
  // one. Clicking the button again while already in a list of that type is
  // now a no-op instead.
  it("clicking the same list-type button again while already inside that list is a no-op", () => {
    const doc = schema.node("doc", { settings: [] }, [
      schema.node("ordered_list", { order: 1 }, [
        schema.node("list_item", null, [schema.node("paragraph", null, [schema.text("node1")])]),
      ]),
    ]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, textPosition(doc, "node1")),
    });

    const result = applyCommand(state, toggleOrderedList);
    expect(result.applied).toBe(false);
    expect(result.state.doc.eq(doc)).toBe(true); // nothing changed
  });

  it("the full reported sequence (type, toolbar, Enter, repeat) stays one list", () => {
    // node1 <click "1. List"> <Enter> node2 <click "1. List" again>
    // <Enter> node3 <click "1. List" again> — the exact live repro.
    let doc = schema.node("doc", { settings: [] }, [
      schema.node("paragraph", null, [schema.text("node1")]),
    ]);
    let state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, textPosition(doc, "node1") + "node1".length),
    });

    state = applyCommand(state, toggleOrderedList).state; // wraps node1

    for (const text of ["node2", "node3"]) {
      const split = applyCommand(state, splitListItemCommand);
      expect(split.applied).toBe(true);
      state = split.state;
      state = state.apply(state.tr.insertText(text));
      applyCommand(state, toggleOrderedList); // no-op now; must not fragment the list
    }

    doc = state.doc;
    expect(doc.childCount).toBe(1);
    expect(doc.child(0).type).toBe(schema.nodes.ordered_list);
    expect(doc.child(0).childCount).toBe(3);
    expect(pmDocToTypst(doc)).toBe("1. node1\n2. node2\n3. node3");
  });

  it("toggling one list kind doesn't touch an unrelated list elsewhere in the doc", () => {
    const doc = schema.node("doc", { settings: [] }, [
      schema.node("paragraph", null, [schema.text("first")]),
      schema.node("paragraph", null, [schema.text("second")]),
    ]);
    let state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1, 1),
    });
    state = applyCommand(state, toggleOrderedList).state;
    expect(state.doc.child(0).type).toBe(schema.nodes.ordered_list);

    // isInsideList walks *this selection's* ancestors, not the whole doc —
    // toggling bullet_list on the still-untouched second paragraph must wrap
    // it independently, leaving the first paragraph's ordered_list alone.
    // Positions shifted after the first toggle, so re-locate "second" fresh.
    const secondPos = textPosition(state.doc, "second");
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, secondPos)));
    const result = applyCommand(state, toggleBulletList);
    expect(result.applied).toBe(true);
    expect(result.state.doc.child(0).type).toBe(schema.nodes.ordered_list);
    expect(result.state.doc.childCount).toBe(2);
    expect(result.state.doc.child(1).type).toBe(schema.nodes.bullet_list);
  });
});

describe("sink/lift list items", () => {
  it("sinkList nests the second item under the first, liftList undoes it", () => {
    const doc = schema.node("doc", { settings: [] }, [
      schema.node("bullet_list", null, [
        schema.node("list_item", null, [schema.node("paragraph", null, [schema.text("one")])]),
        schema.node("list_item", null, [schema.node("paragraph", null, [schema.text("two")])]),
      ]),
    ]);
    const pos = textPosition(doc, "two");
    let state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, pos) });

    const sunk = applyCommand(state, sinkList);
    expect(sunk.applied).toBe(true);
    state = sunk.state;
    expect(state.doc.child(0).childCount).toBe(1); // only "one" left at the top level
    const firstItem = state.doc.child(0).child(0);
    expect(firstItem.childCount).toBe(2); // its own paragraph + the nested list
    expect(firstItem.child(1).type).toBe(schema.nodes.bullet_list);

    const lifted = applyCommand(state, liftList);
    expect(lifted.applied).toBe(true);
    expect(lifted.state.doc.child(0).childCount).toBe(2);
  });
});

describe("Enter inside a list item (regression: schema.ts's list_item content order)", () => {
  // A user-reported bug: pressing Enter to continue a WYSIWYG list produced
  // separate single-item lists (blank lines between them, each showing "1."
  // independently) instead of one continuous list. Root cause: list_item's
  // content expression listed `heading` before `paragraph`
  // ("(heading | paragraph | ...)"), and ProseMirror resolves a content
  // expression's *default* block type — used by splitListItem when Enter
  // creates a fresh empty item — to whichever alternative comes first. Every
  // new item silently became a heading instead of a paragraph.

  it("pressing Enter after non-empty item text creates a new paragraph item, not a heading", () => {
    const doc = schema.node("doc", { settings: [] }, [
      schema.node("ordered_list", { order: 1 }, [
        schema.node("list_item", null, [schema.node("paragraph", null, [schema.text("node1")])]),
      ]),
    ]);
    const pos = textPosition(doc, "node1") + "node1".length;
    const state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, pos) });

    const result = applyCommand(state, splitListItemCommand);
    expect(result.applied).toBe(true);
    const list = result.state.doc.child(0);
    expect(list.childCount).toBe(2);
    const newItem = list.child(1);
    expect(newItem.child(0).type).toBe(schema.nodes.paragraph);
    expect(newItem.child(0).type).not.toBe(schema.nodes.heading);
  });

  it("pressing Enter twice more keeps building one list, not separate lists", () => {
    // The end-to-end shape of the reported bug: three items authored via
    // Enter (as in WYSIWYG) must land in one ordered_list with 3 children —
    // not three separate single-item lists (which is what silently
    // producing a heading each time led to, since a heading item couldn't
    // continue the list the way a paragraph item does).
    let doc = schema.node("doc", { settings: [] }, [
      schema.node("ordered_list", { order: 1 }, [
        schema.node("list_item", null, [schema.node("paragraph", null, [schema.text("node1")])]),
      ]),
    ]);
    let state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, textPosition(doc, "node1") + "node1".length),
    });

    // node2<Enter>, node3: splitListItem on an *empty* item (Enter pressed
    // twice with nothing typed in between) lifts it out of the list instead
    // of splitting again — matching real typing (type text, then Enter)
    // rather than that edge case.
    for (const text of ["node2", "node3"]) {
      const split = applyCommand(state, splitListItemCommand);
      expect(split.applied).toBe(true);
      state = split.state;
      // Selection now sits inside the new empty item's paragraph; type into it.
      state = state.apply(state.tr.insertText(text));
    }

    doc = state.doc;
    expect(doc.childCount).toBe(1); // one top-level node, not three
    const list = doc.child(0);
    expect(list.type).toBe(schema.nodes.ordered_list);
    expect(list.childCount).toBe(3);
    list.forEach((item) => expect(item.child(0).type).toBe(schema.nodes.paragraph));

    // The exact symptom from the report: sequential numbering, no blank
    // lines between items (which is what three *separate* one-item lists,
    // each defaulting to order 1, would have produced).
    expect(pmDocToTypst(doc)).toBe("1. node1\n2. node2\n3. node3");
  });
});
