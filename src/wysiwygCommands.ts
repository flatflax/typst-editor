// ProseMirror commands + keymap for the WYSIWYG toolbar (plan.md M5:
// "keymaps/toolbar for the subset (bold/italic/heading level/lists)").
// Pure `prosemirror-state`/`-commands`/`-keymap` logic — no DOM, so it's
// unit-testable headlessly (see wysiwygCommands.test.ts) without mounting an
// EditorView.
import { Plugin, TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { Fragment, type Node as PMNode, type NodeType } from "prosemirror-model";
import { baseKeymap, chainCommands, setBlockType, toggleMark } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import {
  addColumnAfter,
  addRowAfter,
  deleteColumn,
  deleteRow,
  goToNextCell,
} from "prosemirror-tables";
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

// Inserts an empty `rows` x `cols` table at the cursor (plan.md M10). No
// custom per-column widths to offer here, so `columnsRaw` starts as a plain
// integer matching `cols` — same shape a WYSIWYG-authored table always ends
// up serializing as anyway once it no longer matches a stale stored value
// (see typstAst.ts's serializeTable).
export function insertTable(rows: number, cols: number): Command {
  return (state, dispatch) => {
    if (!dispatch) return true;
    const makeCell = () => schema.nodes.table_cell.create(null, [schema.nodes.paragraph.create()]);
    const makeRow = () => schema.nodes.table_row.create(null, Array.from({ length: cols }, makeCell));
    const table = schema.nodes.table.create(
      { columnsRaw: String(cols), columnCount: cols },
      Array.from({ length: rows }, makeRow),
    );
    dispatch(state.tr.replaceSelectionWith(table).scrollIntoView());
    return true;
  };
}

export const insertTable2x2 = insertTable(2, 2);
export const addTableRow = addRowAfter;
export const addTableColumn = addColumnAfter;
export const deleteTableRow = deleteRow;
export const deleteTableColumn = deleteColumn;

// Inserts an empty paragraph right after the block at `pos` (the position
// *before* that block, e.g. from `doc.forEach`) and moves the cursor into
// it — the per-block "+" insert affordance (plan.md M12). A block-insertion
// primitive is a plain `(state, dispatch) => boolean` like the rest of this
// file's commands, not something WysiwygEditor.tsx's decoration plugin needs
// to special-case.
export function insertParagraphAfter(pos: number, nodeSize: number): Command {
  return (state, dispatch) => {
    if (!dispatch) return true;
    const after = pos + nodeSize;
    const tr = state.tr.insert(after, schema.nodes.paragraph.create());
    dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(after))).scrollIntoView());
    return true;
  };
}

// The slash-command menu's trigger condition (plan.md M12): the cursor sits
// right after a lone "/" that is the *entire* content of its paragraph —
// deliberately narrow (not "anywhere after a /") so it can't misfire while
// typing a URL, a fraction, or any other legitimate use of the character
// mid-sentence. Pure `EditorState` inspection, no DOM, so it's headlessly
// testable — WysiwygEditor.tsx calls this after every transaction and, only
// when it returns non-null, computes the menu's on-screen position via
// `view.coordsAtPos` (which does need a live view).
export function slashMenuTriggerAt(state: EditorState): number | null {
  const { $from, empty } = state.selection;
  if (!empty) return null;
  if ($from.parent.type !== schema.nodes.paragraph) return null;
  if ($from.parent.textContent !== "/" || $from.parentOffset !== 1) return null;
  return $from.pos;
}

// Removes the triggering "/" (`slashMenuTriggerAt`'s return value is the
// position right after it) and then runs `command` — shared by every
// slash-menu item so each one only has to name the command it wants, not
// repeat the delete-then-run sequence.
export function runSlashMenuCommand(
  view: { state: EditorState; dispatch: (tr: Transaction) => void },
  triggerPos: number,
  command: Command,
) {
  view.dispatch(view.state.tr.delete(triggerPos - 1, triggerPos));
  command(view.state, view.dispatch);
}

export type SlashMenuItem = { label: string; command: Command };

// Deliberately excludes Image: unlike every other entry, inserting one needs
// an open document (to resolve a relative path against, plan.md M11) and a
// file-picker round trip, so it stays a plain toolbar button rather than a
// slash-menu entry that could silently no-op before a file exists.
export const SLASH_MENU_ITEMS: SlashMenuItem[] = [
  { label: "Heading 1", command: setHeading(1) },
  { label: "Heading 2", command: setHeading(2) },
  { label: "Heading 3", command: setHeading(3) },
  { label: "Bullet list", command: toggleBulletList },
  { label: "Numbered list", command: toggleOrderedList },
  { label: "Table", command: insertTable2x2 },
];

// A table (or an image/typst_call/unsupported_block — any "closed" block
// with no natural way to move the cursor past it) at the very end of the
// document otherwise traps the cursor there: reported live as "if the last
// line is a table, the user can not add a new blank line." Appending an
// empty paragraph whenever the doc's last child isn't one already fixes
// this generally rather than special-casing tables. Harmless when it turns
// out not to be needed: an empty paragraph serializes to nothing
// (typstAst.ts's pmDocToTypst skips zero-length blocks), so this can never
// leak an unwanted blank line into the saved Typst/Markdown source.
export function withTrailingParagraph(doc: PMNode): PMNode {
  const last = doc.lastChild;
  if (last && last.type !== schema.nodes.paragraph) {
    return doc.copy(doc.content.append(Fragment.from(schema.nodes.paragraph.create())));
  }
  return doc;
}

// The ongoing-edit half of the same fix — `withTrailingParagraph` only
// covers the doc as initially loaded/switched into the view; this plugin
// re-applies the same rule after every transaction, e.g. right after the
// user inserts a table as the new last block via the toolbar/slash menu.
export function ensureTrailingParagraphPlugin(): Plugin {
  return new Plugin({
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((tr) => tr.docChanged)) return null;
      const last = newState.doc.lastChild;
      if (last && last.type !== schema.nodes.paragraph) {
        return newState.tr.insert(newState.doc.content.size, schema.nodes.paragraph.create());
      }
      return null;
    },
  });
}

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
    // goToNextCell returns false outside a table, falling through to the
    // list-sink/lift behavior below — inside one, Tab/Shift-Tab move
    // between cells instead (the conventional table-editing meaning), which
    // takes priority since it's the more specific context.
    Tab: chainCommands(goToNextCell(1), sinkList),
    "Shift-Tab": chainCommands(goToNextCell(-1), liftList),
  });
}
