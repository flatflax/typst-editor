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
  // Every UTF-8 encoding uses at least 1 byte per UTF-16 code unit (the ratio is exactly
  // 1 for ASCII, and higher for everything else), so the UTF-16 offset a given byte
  // offset maps to is never greater than the byte offset itself — slicing `text` to
  // `byteOffset` UTF-16 units is always a safe, generous upper bound on where it falls.
  // Without this bound, this used to re-encode the *entire* document on every call
  // regardless of how small `byteOffset` was — O(document length) per call, dozens of
  // calls per interaction (block splitting/focusing), measurably slow on a real
  // multi-page document (see phase4-product-validation.md).
  const bound = Math.min(byteOffset, text.length);
  const bytes = utf8Encoder.encode(text.slice(0, bound));
  return utf8Decoder.decode(bytes.subarray(0, byteOffset)).length;
}

// One Unicode code point forward/backward from a UTF-16 offset, respecting
// surrogate pairs (so a character outside the BMP, e.g. some emoji, steps as
// one unit rather than splitting it into an unpaired half). Code-point-aware,
// not full grapheme-cluster-aware (combining marks/ZWJ sequences would still
// step individually) — sufficient for this project's CJK/Latin content; a
// full `Intl.Segmenter`-based grapheme walk would be the fix if that ever
// becomes a real gap.
export function nextCodePointOffset(text: string, utf16Offset: number): number {
  if (utf16Offset >= text.length) return text.length;
  const code = text.charCodeAt(utf16Offset);
  const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
  const hasLowSurrogate =
    isHighSurrogate &&
    utf16Offset + 1 < text.length &&
    text.charCodeAt(utf16Offset + 1) >= 0xdc00 &&
    text.charCodeAt(utf16Offset + 1) <= 0xdfff;
  return utf16Offset + (hasLowSurrogate ? 2 : 1);
}

export function prevCodePointOffset(text: string, utf16Offset: number): number {
  if (utf16Offset <= 0) return 0;
  const code = text.charCodeAt(utf16Offset - 1);
  const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff;
  const hasHighSurrogate =
    isLowSurrogate &&
    utf16Offset - 2 >= 0 &&
    text.charCodeAt(utf16Offset - 2) >= 0xd800 &&
    text.charCodeAt(utf16Offset - 2) <= 0xdbff;
  return utf16Offset - (hasHighSurrogate ? 2 : 1);
}
