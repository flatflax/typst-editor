// Markdown source <-> Editor Model (plan.md M4). Unlike the Typst spoke
// (src/typstAst.ts), remark runs directly in this process — there's no
// language boundary to cross, so `mdastToDoc`/`pmDocToMdast` map the real
// `mdast` tree straight to/from `PMDoc`, with no separate pruned-JSON layer.
//
// Two encoding conventions carry the Typst-only node kinds through Markdown,
// per plan.md's "`#` function-call support" / "`#set` rule support":
//   - `typst_call` (block form) / a top-level `#set` rule <-> a fenced code
//     block tagged ```typst-call``` / ```typst-set``` containing the raw
//     Typst text verbatim.
//   - `typst_call_inline` <-> inline code (`` `...` ``) whose value starts
//     with `#` — Markdown has no inline-fence mechanism, so this is a
//     narrower, explicit heuristic: inline code that happens to start with a
//     literal `#` gets reinterpreted as a call chip on the next parse. This
//     never loses text (worst case it's mis-categorized, not dropped), and
//     genuine inline code starting with `#` is rare enough to accept for MVP.
//
// Anything else outside the MVP subset (blockquote, tables, links, images,
// raw/other-tagged code blocks, raw HTML, heading level 4+, ...) becomes an
// opaque `unsupported_block`, sliced verbatim from the original source using
// the position info remark-parse attaches to every node — the Markdown-side
// analog of Typst's `SyntaxNode::full_text()`.
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import type {
  BlockContent,
  Code,
  Heading as MdHeading,
  List as MdList,
  ListItem as MdListItem,
  PhrasingContent,
  Root,
  RootContent,
} from "mdast";
import { Node as PMNode } from "prosemirror-model";
import { schema, type PMDoc, type TypstSet } from "./schema";

const FENCE_CALL = "typst-call";
const FENCE_SET = "typst-set";

const parser = unified().use(remarkParse);
const stringifier = unified().use(remarkStringify, { bullet: "-", emphasis: "_", strong: "*" });

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
      const children = flattenInline(node.children, []);
      return children
        ? schema.nodes.paragraph.create(null, children)
        : unsupportedBlockFrom(node, source);
    }
    case "list":
      return convertList(node, source);
    case "code":
      return node.lang === FENCE_CALL
        ? schema.nodes.typst_call.create({ name: parseCallName(node.value), raw: node.value })
        : unsupportedBlockFrom(node, source);
    default:
      // blockquote, table, thematicBreak, html, link/image standing alone,
      // definitions, footnotes, ... — all outside the MVP subset.
      return unsupportedBlockFrom(node, source);
  }
}

const LIST_ITEM_PRIMARY_KINDS = new Set(["heading", "paragraph", "typst_call", "unsupported_block"]);
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
    case "unsupported_block":
      return { type: "html", value: node.attrs.raw as string };
    default:
      throw new Error(`pmDocToMdast: unexpected block "${node.type.name}"`);
  }
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
      out.push(wrapMarks(child.text ?? "", child.marks.map((mark) => mark.type.name)));
    } else if (child.type.name === "hard_break") {
      out.push({ type: "break" });
    } else if (child.type.name === "typst_call_inline") {
      out.push({ type: "inlineCode", value: child.attrs.raw as string });
    }
  });
  return out;
}

// Nests innermost-out as code, then em, then strong — mirrors the ordering
// in src/typstAst.ts's serializeTextRun for consistency across both spokes.
function wrapMarks(text: string, marks: string[]): PhrasingContent {
  let node: PhrasingContent = marks.includes("code")
    ? { type: "inlineCode", value: text }
    : { type: "text", value: text };
  if (marks.includes("em")) node = { type: "emphasis", children: [node] };
  if (marks.includes("strong")) node = { type: "strong", children: [node] };
  return node;
}
