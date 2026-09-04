// Typst source <-> Editor Model, via the Rust-side `parse_typst_ast` command
// (plan.md M3). `AstDocument`/`AstBlock`/`AstInline`/`TypstSet` mirror the
// JSON shape produced by `src-tauri/src/ast.rs::parse_typst_ast` — Rust owns
// recognizing Typst's real syntax tree, this module only owns mapping that
// pruned AST into/out of the ProseMirror schema (src/schema.ts).
import { Node as PMNode, type Mark } from "prosemirror-model";
import { schema, type PMDoc, type TypstSet } from "./schema";

export type { TypstSet };

export type AstInline =
  | { type: "text"; text: string; marks: string[] }
  | { type: "linebreak" }
  | { type: "typst_call"; name: string; raw: string }
  // `#link("href")[...]` (plan.md M9): a recursive container, not a mark
  // name in `Text.marks` — see ast.rs's `AstInline::Link` doc comment for
  // why. `children` can itself contain marked-up text, linebreaks, or an
  // inline typst_call, same as any other markup body.
  | { type: "link"; href: string; children: AstInline[] };

export type AstBlock =
  | { type: "heading"; level: number; children: AstInline[] }
  | { type: "paragraph"; children: AstInline[] }
  | { type: "bullet_list"; items: AstBlock[][] }
  | { type: "ordered_list"; start: number; items: AstBlock[][] }
  | { type: "typst_call"; name: string; raw: string }
  | { type: "unsupported_block"; raw: string };

export type AstDocument = { settings: TypstSet[]; content: AstBlock[] };

// ---------------------------------------------------------------------------
// AstDocument -> PMDoc
// ---------------------------------------------------------------------------

export function typstAstToDoc(ast: AstDocument): PMDoc {
  return schema.nodes.doc.create({ settings: ast.settings }, ast.content.map(blockToNode));
}

function blockToNode(block: AstBlock): PMNode {
  switch (block.type) {
    case "heading":
      return schema.nodes.heading.create({ level: block.level }, inlineToNodes(block.children));
    case "paragraph":
      return schema.nodes.paragraph.create(null, inlineToNodes(block.children));
    case "bullet_list":
      return schema.nodes.bullet_list.create(null, block.items.map(listItemToNode));
    case "ordered_list":
      return schema.nodes.ordered_list.create(
        { order: block.start },
        block.items.map(listItemToNode),
      );
    case "typst_call":
      return schema.nodes.typst_call.create({ name: block.name, raw: block.raw });
    case "unsupported_block":
      return schema.nodes.unsupported_block.create({ raw: block.raw });
  }
}

// A list item's blocks are [primary content, ...nested sublists] (matching
// the `list_item` content spec in schema.ts). An empty item (a bare `- `
// with nothing after it) has no primary content from the parser — fall back
// to an empty paragraph so the node still satisfies the schema.
function listItemToNode(items: AstBlock[]): PMNode {
  const children = items.length > 0 ? items.map(blockToNode) : [schema.nodes.paragraph.create()];
  return schema.nodes.list_item.create(null, children);
}

function inlineToNodes(children: AstInline[]): PMNode[] {
  const nodes: PMNode[] = [];
  let bufferText = "";
  let bufferMarks: string[] | null = null;

  const flush = () => {
    if (bufferMarks !== null && bufferText.length > 0) {
      nodes.push(schema.text(bufferText, marksFor(bufferMarks)));
    }
    bufferMarks = null;
    bufferText = "";
  };

  for (const child of children) {
    if (child.type === "text") {
      if (bufferMarks !== null && sameMarks(bufferMarks, child.marks)) {
        bufferText += child.text;
      } else {
        flush();
        bufferMarks = child.marks;
        bufferText = child.text;
      }
      continue;
    }
    flush();
    if (child.type === "linebreak") {
      nodes.push(schema.nodes.hard_break.create());
    } else if (child.type === "typst_call") {
      nodes.push(schema.nodes.typst_call_inline.create({ name: child.name, raw: child.raw }));
    } else {
      // "link": recurse into its body, then stack a `link` mark (with href)
      // on top of every node that recursion produced — text, hard_break, or
      // a nested typst_call_inline all carry marks in this schema, so this
      // handles "bold link" and "link wrapping a call" uniformly.
      // `addToSet` (not `[linkMark, ...node.marks]`) matters: ProseMirror
      // requires a node's marks to be sorted by the schema's mark rank, and
      // link is declared after strong/em/code, so prepending it produces an
      // invalid [link, strong] order that fails `doc.check()`.
      const linkMark = schema.marks.link.create({ href: child.href });
      nodes.push(...inlineToNodes(child.children).map((node) => node.mark(linkMark.addToSet(node.marks))));
    }
  }
  flush();
  return nodes;
}

function sameMarks(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((mark, i) => mark === b[i]);
}

function marksFor(markNames: string[]) {
  return markNames.map((name) => schema.marks[name].create());
}

// ---------------------------------------------------------------------------
// PMDoc -> Typst source
// ---------------------------------------------------------------------------

// One interval tying a PM document position range to the byte range in the
// generated Typst source it produced (plan.md M5: "extend pmDocToTypst to
// also emit a position map ... so the M1 click/cursor-sync feature also
// works while editing in WYSIWYG mode"). Recorded once per inline leaf
// (text run / hard_break / typst_call_inline) and once per block's own
// syntax prefix (heading marker, list marker, a call/unsupported block's
// raw text). Both lookup directions below interpolate *within* an entry's
// range rather than snapping to its start — e.g. clicking mid-paragraph in
// the preview lands the WYSIWYG cursor near that point in the text, not at
// the paragraph's first character. This is still an approximation inside a
// marked-up run (escaping/`*`/`_`/`` ` `` wrappers shift Typst length away
// from PM length), matching the "point/caret-level sync only" precision
// already established for the Typst-source-only case in M1 (plan.md's
// precision note) — close enough to click near, not byte-exact.
export type PositionMapEntry = {
  pmFrom: number;
  pmTo: number;
  typstFrom: number;
  typstTo: number;
};

// Every recursive serialize* helper below returns one of these instead of a
// plain string, carrying position entries local to `text` (typstFrom/typstTo
// 0 = start of this fragment) — `join`/`concat` shift them into the parent's
// coordinate space as fragments are combined, so the full tree assembles
// into one globally-consistent position map alongside the source string.
type Serialized = { text: string; positions: PositionMapEntry[] };

// `pmTo` is deliberately the PM position *right after* this node (`pos +
// child.nodeSize` for inline leaves, `pos + 1` for a block/list-item's own
// marker — which is exactly where that block's content begins, so a prefix
// like "= " and the heading text right after it meet at a shared boundary).
function leaf(pmFrom: number, pmTo: number, text: string): Serialized {
  return text.length > 0
    ? { text, positions: [{ pmFrom, pmTo, typstFrom: 0, typstTo: text.length }] }
    : { text: "", positions: [] };
}

// Text with no associated PM position — used for content (the settings
// block) that doesn't correspond to a position in the doc's flow content.
function unpositioned(text: string): Serialized {
  return { text, positions: [] };
}

function join(parts: Serialized[], separator: string): Serialized {
  let text = "";
  const positions: PositionMapEntry[] = [];
  parts.forEach((part, i) => {
    if (i > 0) text += separator;
    const base = text.length;
    text += part.text;
    for (const p of part.positions) {
      positions.push({
        pmFrom: p.pmFrom,
        pmTo: p.pmTo,
        typstFrom: base + p.typstFrom,
        typstTo: base + p.typstTo,
      });
    }
  });
  return { text, positions };
}

function concat(...parts: Serialized[]): Serialized {
  return join(parts, "");
}

export function pmDocToTypst(doc: PMDoc): string {
  return pmDocToTypstWithPositions(doc).source;
}

export function pmDocToTypstWithPositions(doc: PMDoc): {
  source: string;
  positions: PositionMapEntry[];
} {
  const settings = (doc.attrs.settings ?? []) as TypstSet[];
  const settingsPart =
    settings.length > 0 ? unpositioned(settings.map((s) => s.raw).join("\n")) : unpositioned("");

  const blockParts: Serialized[] = [];
  doc.forEach((node, offset) => {
    const part = serializeBlock(node, offset);
    if (part.text.length > 0) blockParts.push(part);
  });
  const contentPart = join(blockParts, "\n\n");

  const result =
    settingsPart.text && contentPart.text
      ? join([settingsPart, contentPart], "\n\n")
      : settingsPart.text
        ? settingsPart
        : contentPart;

  return { source: result.text, positions: result.positions };
}

// Finds the Typst byte offset a PM document position maps to, interpolating
// within the containing entry's range (see PositionMapEntry's doc comment).
// `positions` must come from `pmDocToTypstWithPositions` for the *same*
// doc — it relies on that array being sorted ascending by both `pmFrom` and
// `typstFrom` simultaneously, which holds because the tree is walked in
// document order and text is only ever appended.
export function pmPosToTypstOffset(positions: PositionMapEntry[], pmPos: number): number | null {
  const entry = findEntry(positions, pmPos, (e) => e.pmFrom);
  if (!entry) return null;
  const ratio = interpolationRatio(pmPos, entry.pmFrom, entry.pmTo);
  return Math.round(entry.typstFrom + ratio * (entry.typstTo - entry.typstFrom));
}

// The inverse of `pmPosToTypstOffset`: given a Typst byte offset (e.g. from
// `jump_from_click`), finds the PM position it corresponds to.
export function typstOffsetToPmPos(positions: PositionMapEntry[], typstOffset: number): number | null {
  const entry = findEntry(positions, typstOffset, (e) => e.typstFrom);
  if (!entry) return null;
  const ratio = interpolationRatio(typstOffset, entry.typstFrom, entry.typstTo);
  return Math.round(entry.pmFrom + ratio * (entry.pmTo - entry.pmFrom));
}

// How far `target` sits into [from, to) as a 0-1 fraction — clamped, so a
// target past the entry's end (e.g. landing in the "\n\n" gap between two
// blocks, which isn't covered by any entry) still resolves to that entry's
// nearest boundary rather than overshooting past it.
function interpolationRatio(target: number, from: number, to: number): number {
  const span = to - from;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (target - from) / span));
}

// The entry whose range contains `target`, keyed by its start — the last
// entry with `key(entry) <= target`, found by binary search (falls back to
// the first entry when `target` precedes everything, clamping instead of
// returning nothing — click/cursor sync should degrade to "nearest known
// thing", never silently do nothing).
function findEntry(
  positions: PositionMapEntry[],
  target: number,
  key: (entry: PositionMapEntry) => number,
): PositionMapEntry | null {
  if (positions.length === 0) return null;
  let lo = 0;
  let hi = positions.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(positions[mid]) <= target) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return positions[best];
}

function serializeBlock(node: PMNode, pos: number): Serialized {
  switch (node.type.name) {
    case "heading":
      return concat(
        leaf(pos, pos + 1, `${"=".repeat(node.attrs.level as number)} `),
        serializeInline(node, pos + 1),
      );
    case "paragraph":
      return serializeInline(node, pos + 1);
    case "bullet_list":
    case "ordered_list":
      return serializeList(node, pos, 0);
    case "typst_call":
    case "unsupported_block":
      return leaf(pos, pos + node.nodeSize, node.attrs.raw as string);
    default:
      throw new Error(`pmDocToTypst: unexpected top-level block "${node.type.name}"`);
  }
}

function serializeList(node: PMNode, pos: number, depth: number): Serialized {
  const isOrdered = node.type.name === "ordered_list";
  let counter = isOrdered ? (node.attrs.order as number) : 0;
  const items: Serialized[] = [];
  node.forEach((item, offset) => {
    const marker = isOrdered ? `${counter}.` : "-";
    items.push(serializeListItem(item, pos + 1 + offset, marker, depth));
    counter += 1;
  });
  return join(items, "\n");
}

function serializeListItem(item: PMNode, pos: number, marker: string, depth: number): Serialized {
  const indent = "  ".repeat(depth);
  const contentStart = pos + 1;
  const primary = item.child(0);
  const parts: Serialized[] = [
    concat(leaf(pos, pos + 1, `${indent}${marker} `), serializePrimary(primary, contentStart)),
  ];
  let childPos = contentStart + primary.nodeSize;
  for (let i = 1; i < item.childCount; i++) {
    const child = item.child(i);
    parts.push(serializeList(child, childPos, depth + 1));
    childPos += child.nodeSize;
  }
  return join(parts, "\n");
}

function serializePrimary(node: PMNode, pos: number): Serialized {
  switch (node.type.name) {
    case "heading":
      return concat(
        leaf(pos, pos + 1, `${"=".repeat(node.attrs.level as number)} `),
        serializeInline(node, pos + 1),
      );
    case "paragraph":
      return serializeInline(node, pos + 1);
    case "typst_call":
    case "unsupported_block":
      return leaf(pos, pos + node.nodeSize, node.attrs.raw as string);
    default:
      throw new Error(`pmDocToTypst: unexpected list item content "${node.type.name}"`);
  }
}

function serializeInline(node: PMNode, contentStart: number): Serialized {
  const parts: Serialized[] = [];
  node.forEach((child, offset) => {
    const pos = contentStart + offset;
    if (child.isText) {
      parts.push(leaf(pos, pos + child.nodeSize, serializeTextRun(child.text ?? "", child.marks)));
    } else if (child.type.name === "hard_break") {
      parts.push(leaf(pos, pos + child.nodeSize, withLinkMark("\\\n", child.marks)));
    } else if (child.type.name === "typst_call_inline") {
      parts.push(leaf(pos, pos + child.nodeSize, withLinkMark(child.attrs.raw as string, child.marks)));
    }
  });
  return concat(...parts);
}

// Typst markup characters that would otherwise be reinterpreted as syntax if
// they appeared literally in plain text (not already inside a `code` run).
// `[`/`]` are included because a link's body text (plan.md M9) is embedded
// inside a `#link(...)[...]` content-block delimiter pair — an unescaped `]`
// there would prematurely close the block; escaping them everywhere (not
// just inside links) is harmless since `\[`/`\]` are ordinary Typst escapes
// anywhere in markup (confirmed by ast.rs's
// escaped_brackets_round_trip_as_literal_bracket_characters test).
const TYPST_TEXT_ESCAPE = /[\\*_`#<@[\]]/g;

function escapeTypstText(text: string): string {
  return text.replace(TYPST_TEXT_ESCAPE, (ch) => `\\${ch}`);
}

function typstStringLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Wraps `text` in `#link("href")[...]` if `marks` carries a `link` mark —
// shared by serializeTextRun and the hard_break/typst_call_inline cases in
// serializeInline, since a link can wrap any of those (plan.md M9). Always
// applied outermost, regardless of the source's original nesting order
// (`*#link(..)[x]*` and `#link(..)[*x*]` both parse to the same PMDoc — see
// ast.rs's link tests — so there's only one canonical serialization).
function withLinkMark(text: string, marks: readonly Mark[]): string {
  const link = marks.find((mark) => mark.type.name === "link");
  return link ? `#link(${typstStringLiteral(link.attrs.href as string)})[${text}]` : text;
}

// Marks nest innermost-out as code, then em, then strong, then link — e.g.
// `*_\`code\`_*` for text carrying strong/em/code — matching how Typst
// itself would parse nested `*_..._*` markup back into the same mark set.
function serializeTextRun(text: string, marks: readonly Mark[]): string {
  const names = marks.map((mark) => mark.type.name);
  let out = names.includes("code") ? `\`${text}\`` : escapeTypstText(text);
  if (names.includes("em")) out = `_${out}_`;
  if (names.includes("strong")) out = `*${out}*`;
  return withLinkMark(out, marks);
}
