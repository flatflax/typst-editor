// Coordinate conversion between screen (client) pixels and a rendered
// Typst SVG's own point (pt) coordinate space, via the SVG's `viewBox`.
// Shared by the split preview pane's click-to-jump (M5) and M20's live
// cursor/selection view — both are just "map a screen point onto/from a
// rendered Typst SVG," regardless of which SVG it is.

// `viewBox.x`/`viewBox.y` matter once a rendered fragment's `viewBox` doesn't
// start at `0 0` (e.g. a cropped region of a larger page) — omitting the
// offset would put every click a fixed amount short of where it should land.
// The main preview's SVG always has a `0 0 ...` viewBox, so this has no
// visible effect there.
export function svgPointFromClient(svg: SVGSVGElement, clientX: number, clientY: number) {
  const rect = svg.getBoundingClientRect();
  const viewBox = svg.viewBox.baseVal;
  return {
    xPt: viewBox.x + ((clientX - rect.left) / rect.width) * viewBox.width,
    yPt: viewBox.y + ((clientY - rect.top) / rect.height) * viewBox.height,
  };
}

export function clientPointFromPt(svg: SVGSVGElement, xPt: number, yPt: number) {
  const rect = svg.getBoundingClientRect();
  const viewBox = svg.viewBox.baseVal;
  return {
    clientX: rect.left + (xPt / viewBox.width) * rect.width,
    clientY: rect.top + (yPt / viewBox.height) * rect.height,
  };
}
