// Shared table of inline "atom" leaf kinds (plan.md M13's inline-layer
// unification): hard_break and typst_call_inline are structurally identical
// across all four inline conversion directions —
// src/spokes/typstAst.ts's inlineToNodes (AstInline -> PM) and serializeInline
// (PM -> Typst text), src/spokes/markdown.ts's flattenInlineNode (mdast -> PM)
// and inlineToMdast (PM -> mdast) — each previously re-implemented "how do I
// build/render a hard_break or typst_call_inline" from scratch. Both are true
// context-free atoms (no children, no marks-accumulation to recurse into),
// differing only in their attrs and how each spoke encodes them, which is
// exactly what one entry per kind below captures.
//
// `text` and the `link` mark deliberately stay outside this table: text
// carries a variable string + accumulated marks rather than being a fixed
// atom, and link is a mark stacked onto whatever a recursive body produces
// (see withLinkMark in both spoke files) rather than a leaf conversion at
// all — genericizing either would leak recursion/accumulator context into
// what is otherwise a flat per-kind table, the same reasoning plan.md gives
// for why the *block* layer's lookahead/accumulation cases stay as named
// functions instead of joining a table.
import type { PhrasingContent } from "mdast";
import { Node as PMNode } from "prosemirror-model";
import { schema } from "../model/schema";
import type { AstInline } from "./typstAst";

export type InlineAtomSpec = {
  pmType: "hard_break" | "typst_call_inline";
  astType: "linebreak" | "typst_call";
  // Only ever called with an `ast` whose `type` already matches `astType`
  // (the caller has switched on the real AstInline union first) — the
  // internal check is just a defensive guard against misuse of the table.
  fromAst: (ast: AstInline) => PMNode;
  toTypstText: (node: PMNode) => string;
  matchesMdast: (node: PhrasingContent) => boolean;
  fromMdast: (node: PhrasingContent) => PMNode;
  toMdast: (node: PMNode) => PhrasingContent;
};

export type InlineAtomPmType = InlineAtomSpec["pmType"];
export type InlineAtomAstType = InlineAtomSpec["astType"];

// Also used by markdown.ts's block-level `typst_call` fence conversion
// (Markdown, unlike the Typst spoke, never gets a pre-parsed `name` field —
// both call sites recover it from the raw `#name(...)` text the same way).
export function parseCallName(raw: string): string {
  return raw.match(/^#([^\s([]+)/)?.[1] ?? "";
}

// Keyed by pmType (a `Record`, not an array) so that omitting an entry for a
// member of `InlineAtomPmType` fails to compile — the same exhaustiveness
// guarantee schema.ts's BlockNodeName/assertNever gives the block layer,
// applied here to the inline table itself rather than to a switch.
const INLINE_ATOM_SPECS_BY_PM_TYPE: Record<InlineAtomPmType, InlineAtomSpec> = {
  hard_break: {
    pmType: "hard_break",
    astType: "linebreak",
    fromAst: () => schema.nodes.hard_break.create(),
    toTypstText: () => "\\\n",
    matchesMdast: (node) => node.type === "break",
    fromMdast: () => schema.nodes.hard_break.create(),
    toMdast: () => ({ type: "break" }),
  },
  typst_call_inline: {
    pmType: "typst_call_inline",
    astType: "typst_call",
    fromAst: (ast) => {
      if (ast.type !== "typst_call") throw new Error('fromAst: expected an AstInline of type "typst_call"');
      return schema.nodes.typst_call_inline.create({ name: ast.name, raw: ast.raw });
    },
    toTypstText: (node) => node.attrs.raw as string,
    // Markdown has no inline-fence mechanism, so this is a narrower, explicit
    // heuristic (plan.md M4): inline code whose value happens to start with a
    // literal `#` is reinterpreted as a call chip — see markdown.ts's header
    // comment for why this is an accepted, non-lossy approximation.
    matchesMdast: (node) => node.type === "inlineCode" && node.value.startsWith("#"),
    fromMdast: (node) => {
      if (node.type !== "inlineCode") throw new Error('fromMdast: expected a PhrasingContent of type "inlineCode"');
      return schema.nodes.typst_call_inline.create({ name: parseCallName(node.value), raw: node.value });
    },
    toMdast: (node) => ({ type: "inlineCode", value: node.attrs.raw as string }),
  },
};

// Iteration order here is also atomSpecByMdast's match priority (first
// predicate match wins) — harmless today since the two entries' matchesMdast
// predicates are mutually exclusive (a linebreak vs. `#`-prefixed inline
// code), but if a third atom kind is ever added to this table, either keep
// all matchesMdast predicates mutually exclusive or make atomSpecByMdast
// assert at most one match instead of silently taking the first.
//
// Not exported: both spoke files only ever need one spec at a time, via
// atomSpecByAstType/atomSpecByPmType/atomSpecByMdast below.
const INLINE_ATOM_SPECS: readonly InlineAtomSpec[] = Object.values(INLINE_ATOM_SPECS_BY_PM_TYPE);

export function atomSpecByAstType(astType: InlineAtomAstType): InlineAtomSpec {
  const spec = INLINE_ATOM_SPECS.find((s) => s.astType === astType);
  if (!spec) throw new Error(`no inline atom spec for AstInline type "${astType}"`);
  return spec;
}

// Not `| undefined`: any non-text inline PM node reaching a call site is, by
// schema.ts's "inline" group, guaranteed to be one of the atom kinds this
// table covers — the "not found" guard lives here instead of being repeated
// at each call site (plan.md M13; previously typstAst.ts's serializeInline
// and markdown.ts's inlineToMdast each carried their own copy of this check).
export function atomSpecByPmType(pmType: string): InlineAtomSpec {
  const spec = (INLINE_ATOM_SPECS_BY_PM_TYPE as Record<string, InlineAtomSpec | undefined>)[pmType];
  if (!spec) throw new Error(`no inline atom spec for PM node type "${pmType}"`);
  return spec;
}

export function atomSpecByMdast(node: PhrasingContent): InlineAtomSpec | undefined {
  return INLINE_ATOM_SPECS.find((s) => s.matchesMdast(node));
}
