// M15a (plan.md): hides every top-level block's DOM except the one
// containing the selection, via a `style: "display: none"` decoration —
// not a direct DOM mutation.
//
// `EditorView.nodeDOM`'s own doc comment explicitly warns against mutating
// a node's DOM directly this way ("will be immediately overriden by the
// editor as it redraws the node") — confirmed the hard way during
// development: a manual `dom.style.display = "none"` was silently wiped by
// ProseMirror's own reconciliation on the very next redraw, so nothing ever
// stayed hidden. Decorations are the correct channel instead: PM applies
// decoration-provided attributes itself as part of its own reconciliation,
// so they survive redraws rather than being fought by them.
//
// This only adds an attribute to a node's *own* existing DOM (whatever its
// schema's `toDOM` already produces — a `<p>` stays a `<p>`) — it doesn't
// wrap anything in extra structure, unlike the discarded NodeView-based
// version of this feature that corrupted document content by diverging
// from the schema's own DOM shape.
//
// Applies to every top-level node type, not just paragraph/heading —
// otherwise a list/table/image sitting in the "before"/"after" crop region
// (App.tsx) would render twice: once live here, once inside the crop image.
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorState } from "prosemirror-state";

export const activeBlockPluginKey = new PluginKey<DecorationSet>("activeBlock");

function decorationsFor(state: EditorState): DecorationSet {
  const { $from } = state.selection;
  const activePos = $from.depth >= 1 ? $from.before(1) : null;

  const decorations: Decoration[] = [];
  state.doc.forEach((node, pos) => {
    if (pos !== activePos) {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { style: "display: none" }));
    }
  });
  return DecorationSet.create(state.doc, decorations);
}

export const activeBlockPlugin = new Plugin<DecorationSet>({
  key: activeBlockPluginKey,
  state: {
    init: (_config, state) => decorationsFor(state),
    apply(tr, decorations, _oldState, newState) {
      if (!tr.docChanged && !tr.selectionSet) return decorations;
      return decorationsFor(newState);
    },
  },
  props: {
    decorations(state) {
      return activeBlockPluginKey.getState(state) ?? null;
    },
  },
});
