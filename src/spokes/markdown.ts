// Markdown source <-> Editor Model (plan.md M4). Unlike the Typst spoke
// (src/spokes/typstAst.ts), remark runs directly in this process — there's no
// language boundary to cross, so `mdastToDoc`/`pmDocToMdast` map the real
// `mdast` tree straight to/from `PMDoc`, with no separate pruned-JSON layer.
//
// Three encoding conventions carry the Typst-only node kinds through
// Markdown, per plan.md's "`#` function-call support" / "`#set` rule
// support":
//   - `typst_call` (block form) / a top-level `#set` rule <-> a fenced code
//     block tagged ```typst-call``` / ```typst-set``` containing the raw
//     Typst text verbatim.
//   - `typst_call_inline` <-> inline code (`` `...` ``) whose value starts
//     with `#` — Markdown has no inline-fence mechanism, so this is a
//     narrower, explicit heuristic: inline code that happens to start with a
//     literal `#` gets reinterpreted as a call chip on the next parse. This
//     never loses text (worst case it's mis-categorized, not dropped), and
//     genuine inline code starting with `#` is rare enough to accept for MVP.
//   - `unsupported_block` <-> a fenced code block tagged ```typst-raw```
//     containing its raw text verbatim. *Not* plain passthrough text: an
//     unsupported_block's raw content usually isn't Typst-flavored HTML or
//     anything else Markdown itself finds unusual (e.g. "$ x^2 $" is just
//     ordinary text to CommonMark) — emitted as bare text it would silently
//     reparse as an ordinary *supported* paragraph next time, losing its
//     opaque status. A fence is unambiguous regardless of what's inside it.
//
// Anything else outside the MVP subset that Markdown's *own* grammar makes
// distinct from plain text (blockquote, tables, links, images, raw HTML,
// other-tagged code blocks, heading level 4+, ...) becomes an opaque
// `unsupported_block` too, sliced verbatim from the original source using
// the position info remark-parse attaches to every node — the Markdown-side
// analog of Typst's `SyntaxNode::full_text()`.
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkGfm from "remark-gfm";
import type {
  BlockContent,
  Code,
  Heading as MdHeading,
  List as MdList,
  ListItem as MdListItem,
  PhrasingContent,
  Root,
  RootContent,
  Table as MdTable,
  TableCell as MdTableCell,
  TableRow as MdTableRow,
} from "mdast";
import { Node as PMNode, type Mark } from "prosemirror-model";
import { schema, type PMDoc, type TypstSet } from "../model/schema";
import { pmDocToTypst } from "./typstAst";

const FENCE_CALL = "typst-call";
const FENCE_SET = "typst-set";
const FENCE_UNSUPPORTED = "typst-raw";

// remark-gfm adds table (plus autolink/strikethrough/task-list, unused here)
// parsing/stringifying on top of core CommonMark (plan.md M10).
const parser = unified().use(remarkParse).use(remarkGfm);
const stringifier = unified()
  .use(remarkStringify, { bullet: "-", emphasis: "_", strong: "*" })
  .use(remarkGfm);

export function markdownToDoc(source: string): PMDoc {
  const root = parser.parse(source) as unknown as Root;
  return mdastToDoc(root, source);
}

export function docToMarkdown(doc: PMDoc): string {
  return String(stringifier.stringify(pmDocToMdast(doc))).trimEnd();
}

// ---------------------------------------------------------------------------
// mdast -> PMDoc
// ---------------------------------------------------------------------------

export function mdastToDoc(root: Root, source: string): PMDoc {
  const settings: TypstSet[] = [];
  const content = convertBlocks(root.children, source, settings, true);
  return schema.nodes.doc.create({ settings }, content);
}

function convertBlocks(
  nodes: RootContent[],
  source: string,
  settings: TypstSet[],
  isRoot: boolean,
): PMNode[] {
  const blocks: PMNode[] = [];
  for (const node of nodes) {
    if (isRoot && node.type === "code" && node.lang === FENCE_SET) {
      settings.push({ function: parseSetFunction(node.value), raw: node.value });
      continue;
    }
    blocks.push(convertBlock(node, source));
  }
  return blocks;
}

function convertBlock(node: RootContent, source: string): PMNode {
  switch (node.type) {
    case "heading": {
      if (node.depth > 3) return unsupportedBlockFrom(node, source);
      const children = flattenInline(node.children, []);
      return children
        ? schema.nodes.heading.create({ level: node.depth }, children)
        : unsupportedBlockFrom(node, source);
    }
    case "paragraph": {
      // `![alt](src)` (plan.md M11): mdast has no standalone block-level
      // image construct — even a lone image on its own line parses as a
      // one-child paragraph — so this is the mdast->PM equivalent of
      // ast.rs's try_flatten_pending "single significant node" check.
      const soleImage = imageFromSoleChild(node.children);
      if (soleImage) return soleImage;
      const children = flattenInline(node.children, []);
      return children
        ? schema.nodes.paragraph.create(null, children)
        : unsupportedBlockFrom(node, source);
    }
    case "list":
      return convertList(node, source);
    case "table":
      return convertTable(node) ?? unsupportedBlockFrom(node, source);
    case "code":
      if (node.lang === FENCE_CALL) {
        return schema.nodes.typst_call.create({ name: parseCallName(node.value), raw: node.value });
      }
      if (node.lang === FENCE_UNSUPPORTED) {
        return schema.nodes.unsupported_block.create({ raw: node.value });
      }
      return unsupportedBlockFrom(node, source);
    default:
      // blockquote, thematicBreak, html, link/image standing alone,
      // definitions, footnotes, ... — all outside the MVP subset.
      return unsupportedBlockFrom(node, source);
  }
}

// A captioned Typst figure round-trips as the image's *alt* text (plan.md
// M11 — Markdown has no native figure/caption construct, so this is the
// spoke's accepted ceiling: a caption with marks would need to lose them to
// survive this leg, so ast.rs's as_figure_call already restricts captions to
// plain text, matching this exactly rather than being an arbitrary
// Typst-only limitation).
function imageFromSoleChild(children: PhrasingContent[]): PMNode | null {
  if (children.length !== 1 || children[0].type !== "image") return null;
  const image = children[0];
  return schema.nodes.image.create({ src: image.url, caption: image.alt || null });
}

// A GFM table is always a rectangular grid of inline-only cells by
// construction (its own pipe-table syntax can't express anything else), so
// unlike the Typst spoke's `as_table_call` this never needs to reject a
// ragged/malformed shape — only an individual cell's *inline* content
// falling outside the MVP subset (an image, a footnote reference, ...)
// can fail, in which case `null` signals the caller to fall back to
// `unsupported_block` for the whole table, same policy as elsewhere. No
// `columns:` source to preserve (Markdown has no such concept) — always a
// plain integer matching the actual column count (plan.md M10).
function convertTable(node: MdTable): PMNode | null {
  const rows: PMNode[] = [];
  let columnCount = 0;
  for (const row of node.children) {
    const cells: PMNode[] = [];
    for (const cell of row.children) {
      const children = flattenInline(cell.children, []);
      if (!children) return null;
      cells.push(schema.nodes.table_cell.create(null, [schema.nodes.paragraph.create(null, children)]));
    }
    columnCount = Math.max(columnCount, cells.length);
    rows.push(schema.nodes.table_row.create(null, cells));
  }
  return schema.nodes.table.create({ columnsRaw: String(columnCount), columnCount }, rows);
}

const LIST_ITEM_PRIMARY_KINDS = new Set([
  "heading",
  "paragraph",
  "typst_call",
  "table",
  "image",
  "unsupported_block",
]);
const LIST_KINDS = new Set(["bullet_list", "ordered_list"]);

function convertList(node: MdList, source: string): PMNode {
  const items = node.children.map((item) => convertListItem(item, source));
  return node.ordered
    ? schema.nodes.ordered_list.create({ order: node.start ?? 1 }, items)
    : schema.nodes.bullet_list.create(null, items);
}

// A list item's content must be exactly one primary block (heading,
// paragraph, typst_call, or unsupported_block) followed by zero or more
// nested sublists (schema.ts's `list_item` content spec). Markdown allows
// more than that — e.g. multiple paragraphs in one "loose" list item — which
// falls outside that shape; rather than bending the schema further, such an
// item collapses to a single verbatim `unsupported_block` for the whole
// item, the same "opaque escape hatch" policy used everywhere else.
function convertListItem(item: MdListItem, source: string): PMNode {
  const settings: TypstSet[] = []; // a #set inside a list item isn't lifted (not root), mirrors ast.rs's is_root
  const blocks = convertBlocks(item.children, source, settings, false);
  if (blocks.length === 0) {
    return schema.nodes.list_item.create(null, [schema.nodes.paragraph.create()]);
  }
  const [first, ...rest] = blocks;
  const isValidShape =
    LIST_ITEM_PRIMARY_KINDS.has(first.type.name) && rest.every((n) => LIST_KINDS.has(n.type.name));
  const children = isValidShape ? blocks : [unsupportedBlockFrom(item, source)];
  return schema.nodes.list_item.create(null, children);
}

const MARK_ORDER = ["strong", "em", "code"];

function addMark(marks: string[], mark: string): string[] {
  if (marks.includes(mark)) return marks;
  return MARK_ORDER.filter((m) => marks.includes(m) || m === mark);
}

function marksFor(markNames: string[]) {
  return markNames.map((name) => schema.marks[name].create());
}

// Returns null (rather than throwing) when the run contains anything outside
// the MVP inline subset, signaling the caller to fall back to a verbatim
// `unsupported_block` for the whole enclosing heading/paragraph.
function flattenInline(nodes: PhrasingContent[], marks: string[]): PMNode[] | null {
  const out: PMNode[] = [];
  for (const node of nodes) {
    if (!flattenInlineNode(node, marks, out)) return null;
  }
  return out;
}

function flattenInlineNode(node: PhrasingContent, marks: string[], out: PMNode[]): boolean {
  switch (node.type) {
    case "text":
      if (node.value.length > 0) out.push(schema.text(node.value, marksFor(marks)));
      return true;
    case "break":
      out.push(schema.nodes.hard_break.create());
      return true;
    case "strong":
      return flattenChildren(node.children, addMark(marks, "strong"), out);
    case "emphasis":
      return flattenChildren(node.children, addMark(marks, "em"), out);
    case "inlineCode":
      if (node.value.startsWith("#")) {
        out.push(
          schema.nodes.typst_call_inline.create({
            name: parseCallName(node.value),
            raw: node.value,
          }),
        );
      } else {
        out.push(schema.text(node.value, marksFor(addMark(marks, "code"))));
      }
      return true;
    case "link": {
      // A `link` mark, not a node (plan.md M9) — mirrors typstAst.ts's
      // AstInline::Link handling: recurse into the body with the *inherited*
      // marks (so e.g. a link nested in `**bold**` still gets both), then
      // stack the link mark on top of every node that produced. `addToSet`
      // (not prepending) keeps the mark array in the schema's required rank
      // order — see typstAst.ts's inlineToNodes for the same requirement.
      const linkChildren: PMNode[] = [];
      if (!flattenChildren(node.children, marks, linkChildren)) return false;
      const linkMark = schema.marks.link.create({ href: node.url });
      for (const child of linkChildren) out.push(child.mark(linkMark.addToSet(child.marks)));
      return true;
    }
    default:
      return false;
  }
}

function flattenChildren(nodes: PhrasingContent[], marks: string[], out: PMNode[]): boolean {
  for (const node of nodes) {
    if (!flattenInlineNode(node, marks, out)) return false;
  }
  return true;
}

function parseSetFunction(raw: string): string {
  return raw.match(/^#set\s+([^\s(]+)/)?.[1] ?? "";
}

function parseCallName(raw: string): string {
  return raw.match(/^#([^\s([]+)/)?.[1] ?? "";
}

function sliceSource(node: RootContent | MdListItem, source: string): string {
  const position = node.position;
  return position ? source.slice(position.start.offset, position.end.offset) : "";
}

function unsupportedBlockFrom(node: RootContent | MdListItem, source: string): PMNode {
  return schema.nodes.unsupported_block.create({ raw: sliceSource(node, source) });
}

// ---------------------------------------------------------------------------
// PMDoc -> mdast
// ---------------------------------------------------------------------------

export function pmDocToMdast(doc: PMDoc): Root {
  const settings = (doc.attrs.settings ?? []) as TypstSet[];
  const children: RootContent[] = settings.map(
    (set): Code => ({ type: "code", lang: FENCE_SET, meta: null, value: set.raw }),
  );
  doc.forEach((node) => {
    children.push(blockToMdast(node));
  });
  return { type: "root", children };
}

function blockToMdast(node: PMNode): BlockContent {
  switch (node.type.name) {
    case "heading":
      return {
        type: "heading",
        depth: node.attrs.level as MdHeading["depth"],
        children: inlineToMdast(node),
      };
    case "paragraph":
      return { type: "paragraph", children: inlineToMdast(node) };
    case "bullet_list":
      return {
        type: "list",
        ordered: false,
        start: null,
        spread: false,
        children: listItemsToMdast(node),
      };
    case "ordered_list":
      return {
        type: "list",
        ordered: true,
        start: node.attrs.order as number,
        spread: false,
        children: listItemsToMdast(node),
      };
    case "typst_call":
      return { type: "code", lang: FENCE_CALL, meta: null, value: node.attrs.raw as string };
    case "image":
      // mdast has no standalone block-level image — even a lone image on
      // its own line is a one-child paragraph (plan.md M11, mirrors
      // imageFromSoleChild's inverse).
      return {
        type: "paragraph",
        children: [
          {
            type: "image",
            url: node.attrs.src as string,
            alt: (node.attrs.caption as string | null) ?? "",
          },
        ],
      };
    case "table": {
      const asGfm = tableToMdastIfPossible(node);
      if (asGfm) return asGfm;
      // A cell with block content (a heading/list/nested table/...) isn't
      // something GFM pipe tables can express (plan.md M10) — falls back
      // to the same opaque fenced-passthrough convention typst_call/
      // unsupported_block already use on this leg. Reuses pmDocToTypst
      // (wrapping just this node in a throwaway one-block doc) rather than
      // duplicating serializeTable's logic here; the mdast -> PM direction
      // (convertBlock's FENCE_UNSUPPORTED case) reconstructs this as a
      // plain, non-editable unsupported_block, not a structured table —
      // there's no synchronous way to re-derive table structure from raw
      // Typst text without the Rust parser (see this file's header comment).
      return {
        type: "code",
        lang: FENCE_UNSUPPORTED,
        meta: null,
        value: pmDocToTypst(schema.nodes.doc.create({ settings: [] }, [node])),
      };
    }
    case "unsupported_block":
      return { type: "code", lang: FENCE_UNSUPPORTED, meta: null, value: node.attrs.raw as string };
    default:
      throw new Error(`pmDocToMdast: unexpected block "${node.type.name}"`);
  }
}

// The inverse of convertTable: a GFM table cell can only hold a single
// paragraph's worth of inline content, so a table only converts cleanly
// when every cell fits that shape — returns null otherwise, signaling the
// caller to fall back to the opaque convention above.
function tableToMdastIfPossible(node: PMNode): MdTable | null {
  const rows: MdTableRow[] = [];
  let ok = true;
  node.forEach((row) => {
    const cells: MdTableCell[] = [];
    row.forEach((cell) => {
      if (ok && cell.childCount === 1 && cell.child(0).type.name === "paragraph") {
        cells.push({ type: "tableCell", children: inlineToMdast(cell.child(0)) });
      } else {
        ok = false;
      }
    });
    rows.push({ type: "tableRow", children: cells });
  });
  return ok ? { type: "table", children: rows } : null;
}

function listItemsToMdast(list: PMNode): MdListItem[] {
  const items: MdListItem[] = [];
  list.forEach((item) => {
    const children: BlockContent[] = [];
    item.forEach((child) => children.push(blockToMdast(child)));
    items.push({ type: "listItem", spread: false, checked: null, children });
  });
  return items;
}

function inlineToMdast(node: PMNode): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  node.forEach((child) => {
    if (child.isText) {
      out.push(withLinkMark(wrapMarks(child.text ?? "", child.marks.map((mark) => mark.type.name)), child.marks));
    } else if (child.type.name === "hard_break") {
      out.push(withLinkMark({ type: "break" }, child.marks));
    } else if (child.type.name === "typst_call_inline") {
      out.push(withLinkMark({ type: "inlineCode", value: child.attrs.raw as string }, child.marks));
    }
  });
  return out;
}

// Wraps `node` in a mdast `link` if `marks` carries a `link` mark — shared by
// all three inlineToMdast cases, mirrors typstAst.ts's withLinkMark. Always
// applied outermost (same rationale as there: the source's original nesting
// order isn't preserved, only the resulting mark set — a stable fixed point,
// not byte-identical, matching this project's established round-trip
// definition).
function withLinkMark(node: PhrasingContent, marks: readonly Mark[]): PhrasingContent {
  const link = marks.find((mark) => mark.type.name === "link");
  return link ? { type: "link", url: link.attrs.href as string, title: null, children: [node] } : node;
}

// Nests innermost-out as code, then em, then strong — mirrors the ordering
// in src/spokes/typstAst.ts's serializeTextRun for consistency across both spokes.
function wrapMarks(text: string, marks: string[]): PhrasingContent {
  let node: PhrasingContent = marks.includes("code")
    ? { type: "inlineCode", value: text }
    : { type: "text", value: text };
  if (marks.includes("em")) node = { type: "emphasis", children: [node] };
  if (marks.includes("strong")) node = { type: "strong", children: [node] };
  return node;
}
