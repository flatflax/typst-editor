import { describe, expect, it } from "vitest";
import { byteToUtf16Offset, utf16ToByteOffset } from "./offsets";

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
