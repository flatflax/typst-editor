// Typst source <-> Editor Model, via the Rust-side `parse_typst_ast` command
// (plan.md M3). `AstDocument`/`AstBlock`/`AstInline`/`TypstSet` mirror the
// JSON shape produced by `src-tauri/src/ast.rs::parse_typst_ast` — Rust owns
// recognizing Typst's real syntax tree, this module only owns mapping that
// pruned AST into/out of the ProseMirror schema (src/schema.ts).
import { Node as PMNode } from "prosemirror-model";
import { schema, type PMDoc, type TypstSet } from "./schema";

export type { TypstSet };

export type AstInline =
  | { type: "text"; text: string; marks: string[] }
  | { type: "linebreak" }
  | { type: "typst_call"; name: string; raw: string };

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
    } else {
      nodes.push(schema.nodes.typst_call_inline.create({ name: child.name, raw: child.raw }));
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

export function pmDocToTypst(doc: PMDoc): string {
  const settings = (doc.attrs.settings ?? []) as TypstSet[];
  const settingsText = settings.map((s) => s.raw).join("\n");

  const blocks: string[] = [];
  doc.forEach((node) => {
    const text = serializeBlock(node);
    if (text.length > 0) blocks.push(text);
  });
  const contentText = blocks.join("\n\n");

  if (settingsText && contentText) return `${settingsText}\n\n${contentText}`;
  return settingsText || contentText;
}

function serializeBlock(node: PMNode): string {
  switch (node.type.name) {
    case "heading":
      return `${"=".repeat(node.attrs.level as number)} ${serializeInline(node)}`;
    case "paragraph":
      return serializeInline(node);
    case "bullet_list":
    case "ordered_list":
      return serializeList(node, 0);
    case "typst_call":
    case "unsupported_block":
      return node.attrs.raw as string;
    default:
      throw new Error(`pmDocToTypst: unexpected top-level block "${node.type.name}"`);
  }
}

function serializeList(node: PMNode, depth: number): string {
  const isOrdered = node.type.name === "ordered_list";
  let counter = isOrdered ? (node.attrs.order as number) : 0;
  const lines: string[] = [];
  node.forEach((item) => {
    const marker = isOrdered ? `${counter}.` : "-";
    lines.push(serializeListItem(item, marker, depth));
    counter += 1;
  });
  return lines.join("\n");
}

function serializeListItem(item: PMNode, marker: string, depth: number): string {
  const indent = "  ".repeat(depth);
  const lines = [`${indent}${marker} ${serializePrimary(item.child(0))}`];
  for (let i = 1; i < item.childCount; i++) {
    lines.push(serializeList(item.child(i), depth + 1));
  }
  return lines.join("\n");
}

function serializePrimary(node: PMNode): string {
  switch (node.type.name) {
    case "heading":
      return `${"=".repeat(node.attrs.level as number)} ${serializeInline(node)}`;
    case "paragraph":
      return serializeInline(node);
    case "typst_call":
    case "unsupported_block":
      return node.attrs.raw as string;
    default:
      throw new Error(`pmDocToTypst: unexpected list item content "${node.type.name}"`);
  }
}

function serializeInline(node: PMNode): string {
  let out = "";
  node.forEach((child) => {
    if (child.isText) {
      out += serializeTextRun(child.text ?? "", child.marks.map((mark) => mark.type.name));
    } else if (child.type.name === "hard_break") {
      out += "\\\n";
    } else if (child.type.name === "typst_call_inline") {
      out += child.attrs.raw as string;
    }
  });
  return out;
}

// Typst markup characters that would otherwise be reinterpreted as syntax if
// they appeared literally in plain text (not already inside a `code` run).
const TYPST_TEXT_ESCAPE = /[\\*_`#<@]/g;

function escapeTypstText(text: string): string {
  return text.replace(TYPST_TEXT_ESCAPE, (ch) => `\\${ch}`);
}

// Marks nest innermost-out as code, then em, then strong — e.g.
// `*_\`code\`_*` for text carrying all three — matching how Typst itself
// would parse nested `*_..._*` markup back into the same mark set.
function serializeTextRun(text: string, marks: string[]): string {
  let out = marks.includes("code") ? `\`${text}\`` : escapeTypstText(text);
  if (marks.includes("em")) out = `_${out}_`;
  if (marks.includes("strong")) out = `*${out}*`;
  return out;
}
