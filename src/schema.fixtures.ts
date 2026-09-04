// Hand-built PMDoc fixtures for the M2 schema (plan.md M2). These exist to
// give M3 (Typst <-> model) and M4 (Markdown <-> model) round-trip tests a
// shared, known-good set of Editor Model documents to parse into and
// serialize out of — they are not exercised against Typst/Markdown source
// here, only checked for schema validity (see schema.fixtures.test.ts).
import { schema, type PMDoc } from "./schema";

const { doc, paragraph, heading, bullet_list, ordered_list, list_item, unsupported_block } =
  schema.nodes;

// heading levels 1-3 plus a plain paragraph.
export const headingsAndParagraph: PMDoc = doc.create(null, [
  heading.create({ level: 1 }, schema.text("Title")),
  heading.create({ level: 2 }, schema.text("Section")),
  heading.create({ level: 3 }, schema.text("Subsection")),
  paragraph.create(null, schema.text("A plain paragraph.")),
]);

// strong/em/code marks, standalone and combined on one run of text.
export const textWithMarks: PMDoc = doc.create(null, [
  paragraph.create(null, [
    schema.text("plain "),
    schema.text("bold", [schema.marks.strong.create()]),
    schema.text(" "),
    schema.text("italic", [schema.marks.em.create()]),
    schema.text(" "),
    schema.text("code", [schema.marks.code.create()]),
    schema.text(" "),
    schema.text("bold-italic", [schema.marks.strong.create(), schema.marks.em.create()]),
  ]),
]);

// A bullet list with one level of nesting under its second item.
export const nestedBulletList: PMDoc = doc.create(null, [
  bullet_list.create(null, [
    list_item.create(null, [paragraph.create(null, schema.text("Apple"))]),
    list_item.create(null, [
      paragraph.create(null, schema.text("Banana")),
      bullet_list.create(null, [
        list_item.create(null, [paragraph.create(null, schema.text("Sub item"))]),
        list_item.create(null, [paragraph.create(null, schema.text("Another sub item"))]),
      ]),
    ]),
    list_item.create(null, [paragraph.create(null, schema.text("Orange"))]),
  ]),
]);

// An ordered list starting at 1 (the common case — no explicit `order`).
export const orderedList: PMDoc = doc.create(null, [
  ordered_list.create(null, [
    list_item.create(null, [paragraph.create(null, schema.text("First"))]),
    list_item.create(null, [paragraph.create(null, schema.text("Second"))]),
    list_item.create(null, [paragraph.create(null, schema.text("Third"))]),
  ]),
]);

// An ordered list with a non-default start number.
export const orderedListWithStart: PMDoc = doc.create(null, [
  ordered_list.create({ order: 5 }, [
    list_item.create(null, [paragraph.create(null, schema.text("Fifth"))]),
    list_item.create(null, [paragraph.create(null, schema.text("Sixth"))]),
  ]),
]);

// A paragraph on either side of an unsupported region (e.g. a Typst table
// or math block), proving the opaque node keeps the rest of the document
// intact rather than failing the whole parse.
export const withUnsupportedBlock: PMDoc = doc.create(null, [
  paragraph.create(null, schema.text("Before the unsupported region.")),
  unsupported_block.create({ raw: "#table(\n  columns: 2,\n  [a], [b],\n)" }),
  paragraph.create(null, schema.text("After the unsupported region.")),
]);

// A single document combining every node/mark kind, for the "does the whole
// subset survive one round trip" style tests in M3/M4.
export const mixedDocument: PMDoc = doc.create(null, [
  heading.create({ level: 1 }, schema.text("Mixed Document")),
  paragraph.create(null, [
    schema.text("Some "),
    schema.text("bold", [schema.marks.strong.create()]),
    schema.text(" and "),
    schema.text("italic", [schema.marks.em.create()]),
    schema.text(" and "),
    schema.text("code", [schema.marks.code.create()]),
    schema.text("."),
  ]),
  bullet_list.create(null, [
    list_item.create(null, [paragraph.create(null, schema.text("Bullet one"))]),
    list_item.create(null, [paragraph.create(null, schema.text("Bullet two"))]),
  ]),
  ordered_list.create(null, [
    list_item.create(null, [paragraph.create(null, schema.text("Step one"))]),
    list_item.create(null, [paragraph.create(null, schema.text("Step two"))]),
  ]),
  unsupported_block.create({ raw: "$ integral_0^1 x dif x $" }),
  paragraph.create(null, schema.text("Closing paragraph.")),
]);

export const fixtures = {
  headingsAndParagraph,
  textWithMarks,
  nestedBulletList,
  orderedList,
  orderedListWithStart,
  withUnsupportedBlock,
  mixedDocument,
};
