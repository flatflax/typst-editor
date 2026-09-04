import { describe, expect, it } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { schema } from "./schema";
import {
  liftList,
  setHeading,
  setParagraph,
  sinkList,
  toggleBulletList,
  toggleCode,
  toggleEm,
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
  it("toggleBulletList wraps a paragraph, then lifts it back out on a second toggle", () => {
    const doc = schema.node("doc", { settings: [] }, [
      schema.node("paragraph", null, [schema.text("hello")]),
    ]);
    let state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 1, 1) });

    state = applyCommand(state, toggleBulletList).state;
    expect(state.doc.child(0).type).toBe(schema.nodes.bullet_list);
    expect(state.doc.child(0).child(0).type).toBe(schema.nodes.list_item);

    state = applyCommand(state, toggleBulletList).state;
    expect(state.doc.child(0).type).toBe(schema.nodes.paragraph);
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
