// CodeMirror positions are UTF-16 code-unit offsets (native JS string
// indexing); the Rust side works in UTF-8 byte offsets (Typst's Source/Span
// model). These are the same for ASCII but diverge for anything else — e.g.
// every CJK character is 1 UTF-16 unit but 3 UTF-8 bytes — so offsets must
// be converted at this boundary, or they silently drift for any source
// containing non-ASCII text (increasingly so for content further into the
// document).

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

export function utf16ToByteOffset(text: string, utf16Offset: number): number {
  return utf8Encoder.encode(text.slice(0, utf16Offset)).length;
}

export function byteToUtf16Offset(text: string, byteOffset: number): number {
  const bytes = utf8Encoder.encode(text);
  return utf8Decoder.decode(bytes.subarray(0, byteOffset)).length;
}
