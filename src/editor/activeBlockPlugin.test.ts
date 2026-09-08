// @vitest-environment jsdom
//
// The whole file runs under jsdom (not just the live-EditorView block below)
// - vitest only honors this pragma once per file, at the top.
import { describe, expect, it } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { splitBlock } from "prosemirror-commands";
import { schema } from "../model/schema";
import { activeBlockPlugin, activeBlockPluginKey } from "./activeBlockPlugin";
import { ensureTrailingParagraphPlugin } from "./wysiwygCommands";

// Mirrors wysiwygCommands.test.ts's headless-transaction pattern: PM's
// state/plugin machinery is pure and DOM-free, so the exact "select into a
// block, then split it" sequence that broke the WYSIWYG swap UI in manual
// testing can be reproduced and inspected here without a running app.

function textPosition(doc: ReturnType<typeof schema.node>, text: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (node.isText && node.text === text) found = pos;
  });
  if (found < 0) throw new Error(`no text node ${JSON.stringify(text)} found`);
  return found;
}

function activeRanges(state: EditorState): Array<[number, number]> {
  const decorations = activeBlockPluginKey.getState(state);
  if (!decorations) return [];
  return decorations.find().map((d) => [d.from, d.to]);
}

function topLevelPositions(state: EditorState): number[] {
  const positions: number[] = [];
  state.doc.forEach((_node, pos) => positions.push(pos));
  return positions;
}

function docWith3Paragraphs() {
  return schema.node("doc", { settings: [] }, [
    schema.node("paragraph", null, [schema.text("one")]),
    schema.node("paragraph", null, [schema.text("two")]),
    schema.node("paragraph", null, [schema.text("three")]),
  ]);
}

// Everything above this point runs against bare `EditorState` (no DOM) —
// proven correct, but that can't rule out a bug in how PM's own decoration
// diffing applies `style: display:none` to real DOM across a doc-changing
// transaction (as opposed to the *data* being correct). This block mounts a
// real `EditorView` to check that directly.
describe("activeBlockPlugin (live EditorView DOM)", () => {
  function mountView(doc: ReturnType<typeof schema.node>, selPos: number) {
    const dom = document.createElement("div");
    document.body.appendChild(dom);
    const view = new EditorView(dom, {
      state: EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, selPos),
        plugins: [activeBlockPlugin, ensureTrailingParagraphPlugin()],
      }),
    });
    return view;
  }

  // Cross-checks decoration *data* (activeRanges/topLevelPositions, already
  // proven correct above) against the actual rendered DOM: exactly one
  // top-level child element must be visible (not `display:none`), and it
  // must be the one containing the selection.
  function visibleTopLevelChildren(view: EditorView): HTMLElement[] {
    return Array.from(view.dom.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.style.display !== "none",
    );
  }

  it("shows exactly one top-level element and hides the rest, matching the decoration data", () => {
    const view = mountView(docWith3Paragraphs(), textPosition(docWith3Paragraphs(), "two"));
    try {
      expect(view.dom.children.length).toBe(3);
      const visible = visibleTopLevelChildren(view);
      expect(visible.length).toBe(1);
      expect(visible[0].textContent).toBe("two");
    } finally {
      view.destroy();
    }
  });

  it("still shows exactly one top-level element right after a real dispatched Enter-split", () => {
    const doc = docWith3Paragraphs();
    const pos = textPosition(doc, "two") + 1;
    const view = mountView(doc, pos);
    try {
      const applied = splitBlock(view.state, view.dispatch);
      expect(applied).toBe(true);

      expect(view.dom.children.length).toBe(4);
      const visible = visibleTopLevelChildren(view);
      // The one visible element must be the block the cursor actually ended
      // up in - not zero (blank editor) and not more than one (duplicate
      // content), which is exactly the shape of the bugs reported manually.
      expect(visible.length).toBe(1);

      const activePos = view.state.selection.$from.before(1);
      const visibleIndex = Array.from(view.dom.children).indexOf(visible[0]);
      let activeChildIndex = -1;
      let i = 0;
      view.state.doc.forEach((_node, p) => {
        if (p === activePos) activeChildIndex = i;
        i++;
      });
      expect(visibleIndex).toBe(activeChildIndex);
    } finally {
      view.destroy();
    }
  });
});

describe("activeBlockPlugin", () => {
  it("hides every top-level block except the one containing the selection", () => {
    const doc = docWith3Paragraphs();
    const pos = textPosition(doc, "two");
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, pos),
      plugins: [activeBlockPlugin],
    });

    const activePos = state.selection.$from.before(1);
    const hidden = activeRanges(state);

    expect(hidden.length).toBe(2);
    for (const [from] of hidden) {
      expect(from).not.toBe(activePos);
    }
  });

  it("keeps exactly one visible block after Enter splits the block the cursor is in", () => {
    const doc = docWith3Paragraphs();
    // Cursor after "t" in "two" (mid-word, so splitBlock actually splits
    // rather than just moving the cursor to an adjacent empty block).
    const pos = textPosition(doc, "two") + 1;
    let state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, pos),
      plugins: [activeBlockPlugin, ensureTrailingParagraphPlugin()],
    });

    const applied = splitBlock(state, (tr) => {
      state = state.apply(tr);
    });
    expect(applied).toBe(true);

    // "two" split into "t" / "wo" -> 4 top-level paragraphs now.
    expect(state.doc.childCount).toBe(4);

    const activePos = state.selection.$from.before(1);
    const topPositions = topLevelPositions(state);

    // The computed "active" position must correspond to an actual top-level
    // child - if it doesn't (e.g. stale position after the split remapped
    // things), every block gets hidden and the editor goes blank.
    expect(topPositions).toContain(activePos);

    const hidden = activeRanges(state);
    expect(hidden.length).toBe(topPositions.length - 1);
    for (const [from] of hidden) {
      expect(from).not.toBe(activePos);
    }

    // Every top-level position must be covered by exactly one decision:
    // either it's the active block, or it's exactly one hidden decoration -
    // never both hidden and visible, never neither (which would duplicate
    // or blank content).
    const hiddenFroms = new Set(hidden.map(([from]) => from));
    for (const p of topPositions) {
      if (p === activePos) {
        expect(hiddenFroms.has(p)).toBe(false);
      } else {
        expect(hiddenFroms.has(p)).toBe(true);
      }
    }
  });

  it("keeps exactly one visible block after Enter at the very end of the document (trailing-paragraph plugin fires)", () => {
    const doc = docWith3Paragraphs();
    const pos = textPosition(doc, "three") + "three".length;
    let state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, pos),
      plugins: [activeBlockPlugin, ensureTrailingParagraphPlugin()],
    });

    const applied = splitBlock(state, (tr) => {
      state = state.apply(tr);
    });
    expect(applied).toBe(true);

    // splitBlock at the end -> a new empty paragraph; ensureTrailingParagraphPlugin's
    // appendTransaction should NOT also append a second trailing paragraph
    // (the new last child is already a paragraph).
    expect(state.doc.childCount).toBe(4);

    const activePos = state.selection.$from.before(1);
    const topPositions = topLevelPositions(state);
    expect(topPositions).toContain(activePos);

    const hidden = activeRanges(state);
    const hiddenFroms = new Set(hidden.map(([from]) => from));
    for (const p of topPositions) {
      if (p === activePos) expect(hiddenFroms.has(p)).toBe(false);
      else expect(hiddenFroms.has(p)).toBe(true);
    }
  });
});
