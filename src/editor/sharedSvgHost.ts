// M15a (plan.md): owns the *one* copy of the compiled SVG's content in the
// DOM that every inactive paragraph/heading's rendered fragment references
// via `<use>`, instead of each cloning the whole thing itself — see
// phase3-single-view.md's M15a entry for why (N full clones of the same
// content would be wasteful for a longer document).
//
// Single-page only for this slice, matching `jump.rs`'s own existing
// single-page scope (`svg_merged` stacks multi-page output with padding this
// doesn't yet account for) — page 1's rendered content is wrapped in one
// addressable `<g id="typst-page-1">`, wrapping it ourselves since
// `typst_svg::svg_merged`'s output has no such group by default.

const SVG_NS = "http://www.w3.org/2000/svg";
const PAGE_1_GROUP_ID = "typst-page-1";

let hostEl: HTMLElement | null = null;

function ensureHost(): HTMLElement {
  if (hostEl && document.body.contains(hostEl)) return hostEl;
  const el = document.createElement("div");
  el.className = "shared-svg-host";
  // Not `display: none` — some engines won't render `<use>` clones of a
  // display:none source. Zero size + overflow:hidden keeps it out of the
  // visible layout instead, without hiding it from rendering.
  el.style.position = "absolute";
  el.style.width = "0";
  el.style.height = "0";
  el.style.overflow = "hidden";
  document.body.appendChild(el);
  hostEl = el;
  return el;
}

// Parses a freshly compiled SVG string and mounts it (replacing whatever was
// there before) as the one shared copy every block's `<use>` reference
// resolves against. No-op (clears the host) if `svgString` doesn't actually
// parse to an `<svg>` root, e.g. an empty string before the first compile.
export function mountCompiledSvg(svgString: string): void {
  const host = ensureHost();
  if (!svgString) {
    host.replaceChildren();
    return;
  }

  const root = new DOMParser().parseFromString(svgString, "image/svg+xml").documentElement;
  if (root.tagName.toLowerCase() !== "svg" || root.namespaceURI !== SVG_NS) {
    host.replaceChildren();
    return;
  }

  // Move every existing child into one addressable group. `<use>` resolves
  // ids by document-wide lookup, not by proximity to the referenced element,
  // so nesting the original content one level deeper doesn't affect how
  // internal references (gradients, clip-paths, etc.) resolve.
  const group = root.ownerDocument.createElementNS(SVG_NS, "g");
  group.id = PAGE_1_GROUP_ID;
  while (root.firstChild) group.appendChild(root.firstChild);
  root.appendChild(group);

  host.replaceChildren(root);
}

export function page1GroupHref(): string {
  return `#${PAGE_1_GROUP_ID}`;
}
