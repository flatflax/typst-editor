import { describe, expect, it } from "vitest";
import { byteToUtf16Offset, nextCodePointOffset, prevCodePointOffset, utf16ToByteOffset } from "./offsets";

// Mirrors the user-reported bug: CodeMirror's cursor offset (UTF-16 code
// units) was passed straight through to the Rust `jump_from_cursor`/
// `jump_from_click` commands, which expect UTF-8 byte offsets. ASCII text
// hides this (1 unit == 1 byte), but every CJK character is 1 UTF-16 unit
// vs 3 UTF-8 bytes, so the offset drifted further off with each such
// character already before the cursor — breaking sync for a nested list
// appearing after several lines of Chinese heading/paragraph text.
const DOCUMENT = `= 一级标题

普通段落。

- 苹果
- 香蕉
  - 子项目
  - 另一个子项目
- 橙子
`;

describe("utf16ToByteOffset", () => {
  it("is a no-op for pure ASCII text", () => {
    const text = "= Hello\n\nWorld";
    for (const offset of [0, 3, 7, text.length]) {
      expect(utf16ToByteOffset(text, offset)).toBe(offset);
    }
  });

  it("expands each CJK character from 1 UTF-16 unit to 3 UTF-8 bytes", () => {
    const utf16Offset = DOCUMENT.indexOf("子项目") + 1;
    const byteOffset = utf16ToByteOffset(DOCUMENT, utf16Offset);

    const prefix = DOCUMENT.slice(0, utf16Offset);
    const cjkCharsBefore = [...prefix].filter((c) => c.charCodeAt(0) > 0x2e80).length;
    // Naively using the UTF-16 offset as a byte offset (the bug) would land
    // short of the correct byte position by 2 bytes per CJK character
    // already before the cursor.
    expect(byteOffset).toBe(utf16Offset + 2 * cjkCharsBefore);
    expect(cjkCharsBefore).toBeGreaterThan(0);
  });
});

describe("byteToUtf16Offset", () => {
  it("round-trips through utf16ToByteOffset for every character boundary", () => {
    for (let utf16Offset = 0; utf16Offset <= DOCUMENT.length; utf16Offset++) {
      const byteOffset = utf16ToByteOffset(DOCUMENT, utf16Offset);
      expect(byteToUtf16Offset(DOCUMENT, byteOffset)).toBe(utf16Offset);
    }
  });
});

// M20: arrow-key navigation steps by one Unicode code point at a time over
// the UTF-16 offsets these helpers otherwise convert to/from bytes.
describe("nextCodePointOffset / prevCodePointOffset", () => {
  it("steps by one UTF-16 unit for BMP characters (ASCII and CJK alike)", () => {
    const text = "a苹b";
    expect(nextCodePointOffset(text, 0)).toBe(1);
    expect(nextCodePointOffset(text, 1)).toBe(2);
    expect(nextCodePointOffset(text, 2)).toBe(3);
    expect(prevCodePointOffset(text, 3)).toBe(2);
    expect(prevCodePointOffset(text, 2)).toBe(1);
    expect(prevCodePointOffset(text, 1)).toBe(0);
  });

  it("steps over a surrogate pair as one unit, not splitting it", () => {
    const text = "a😀b"; // 😀 is U+1F600, a surrogate pair (2 UTF-16 units)
    expect(text.length).toBe(4);
    expect(nextCodePointOffset(text, 1)).toBe(3); // skip both halves of 😀
    expect(prevCodePointOffset(text, 3)).toBe(1); // and back
    expect(nextCodePointOffset(text, 3)).toBe(4); // b
    expect(prevCodePointOffset(text, 1)).toBe(0); // a
  });

  it("clamps at the string's start and end instead of going out of bounds", () => {
    const text = "ab";
    expect(prevCodePointOffset(text, 0)).toBe(0);
    expect(nextCodePointOffset(text, text.length)).toBe(text.length);
  });

  it("round-trips forward then back to the same offset for every valid boundary", () => {
    // BMP-only text: every integer offset is a valid code-point boundary,
    // unlike text containing a surrogate pair (see the dedicated test above
    // for astral-character correctness — mid-pair offsets aren't valid
    // boundaries to begin with, so round-tripping *from* one isn't
    // meaningful).
    const text = "a苹b香蕉c";
    for (let offset = 0; offset < text.length; offset++) {
      const next = nextCodePointOffset(text, offset);
      expect(prevCodePointOffset(text, next)).toBe(offset);
    }
  });
});
