// ProseMirror commands + keymap for the WYSIWYG toolbar (plan.md M5:
// "keymaps/toolbar for the subset (bold/italic/heading level/lists)").
// Pure `prosemirror-state`/`-commands`/`-keymap` logic — no DOM, so it's
// unit-testable headlessly (see wysiwygCommands.test.ts) without mounting an
// EditorView.
import type { Command, EditorState, Transaction } from "prosemirror-state";
import type { NodeType } from "prosemirror-model";
import { baseKeymap, chainCommands, setBlockType, toggleMark } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { schema } from "./schema";

export const toggleStrong = toggleMark(schema.marks.strong);
export const toggleEm = toggleMark(schema.marks.em);
export const toggleCode = toggleMark(schema.marks.code);

// Unlike the other toggle* commands above, a link mark carries a URL, so a
// bare `toggleMark(schema.marks.link)` can't apply it (plan.md M9). Needs a
// text selection: adds the mark (prompting for the URL) when the range has
// none yet, removes it (no reprompt) when it already does — the standard
// "toggle" meaning for a mark that needs input, matching how most rich-text
// editors handle a link button. Returns false without dispatching for an
// empty selection or a cancelled/blank prompt, so nothing changes.
export function toggleLink(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const { doc, selection } = state;
  const { from, to, empty } = selection;
  if (empty) return false;
  const linkType = schema.marks.link;
  if (doc.rangeHasMark(from, to, linkType)) {
    if (dispatch) dispatch(state.tr.removeMark(from, to, linkType));
    return true;
  }
  if (!dispatch) return true;
  const href = window.prompt("Link URL");
  if (!href) return false;
  dispatch(state.tr.addMark(from, to, linkType.create({ href })));
  return true;
}

export const setParagraph = setBlockType(schema.nodes.paragraph);

export function setHeading(level: 1 | 2 | 3): Command {
  return setBlockType(schema.nodes.heading, { level });
}

function isInsideList(state: Parameters<Command>[0], listType: NodeType): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type === listType) return true;
  }
  return false;
}

// Wraps the selection in a fresh list when it isn't already in one of this
// kind; a no-op (not a toggle-off/lift) when it already is.
//
// An earlier version lifted the item back out on a second click of the same
// button — the conventional toggle behavior — but that turned out to be a
// real trap: Enter already continues a list on its own (splitListItem), so
// a user who *also* re-clicks the list-type button per new line (typing
// node1, clicking "1. List", Enter, node2, clicking "1. List" again out of
// habit/uncertainty, ...) unknowingly lifts the just-continued item back
// out on that second click, fragmenting one list into several — reported as
// a bug, and confirmed live: exactly this sequence produced
// `<ol><li>b1</li></ol><p>b2</p><ol><li>b3</li></ol>` instead of one list.
// Removing a list item is still reachable via Shift-Tab (liftList) at the
// top nesting level; the toolbar button just never does it as a surprising
// side effect of clicking it again.
function toggleList(listType: NodeType): Command {
  return (state, dispatch, view) => {
    if (isInsideList(state, listType)) return false;
    return wrapInList(listType)(state, dispatch, view);
  };
}

export const toggleBulletList = toggleList(schema.nodes.bullet_list);
export const toggleOrderedList = toggleList(schema.nodes.ordered_list);

export const sinkList = sinkListItem(schema.nodes.list_item);
export const liftList = liftListItem(schema.nodes.list_item);

export function buildKeymapPlugin() {
  return keymap({
    ...baseKeymap,
    "Mod-b": toggleStrong,
    "Mod-i": toggleEm,
    "Mod-e": toggleCode,
    "Mod-k": toggleLink,
    // List-aware Enter (splits into a new list item, or exits an empty one)
    // must run before the base Enter (plain splitBlock), which knows nothing
    // about list_item's structure.
    Enter: chainCommands(splitListItem(schema.nodes.list_item), baseKeymap.Enter),
    Tab: sinkList,
    "Shift-Tab": liftList,
  });
}
