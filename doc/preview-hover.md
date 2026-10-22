# Preview hover highlighting — feasibility (2026-10-22)

## Verified Tinymist implementation

Tinymist's SVG preview uses text-group hit testing and CSS, without asking the
compiler to rerender on mouse movement. Its stylesheet sets:

```css
.typst-text {
  pointer-events: bounding-box;
  cursor: text;
}
.typst-text:hover {
  --glyph_fill: #f75c2f;
  --glyph_stroke: #f75c2f;
}
```

The bounding box makes whitespace between glyphs within the group hittable. The
glyph paths consume the fill/stroke variables, so a hovered group changes color.
The apparent highlighted "line" follows the renderer's text grouping, which is
not necessarily one complete visual line when fonts, styles, or runs differ.
Links have a separate related-elements hover path.

Sources inspected at commit `31c3057ec2a9aed81f08256166d1ec2de2e0189a`:

- [SVG preview stylesheet, lines 93–148](https://github.com/Myriad-Dreamin/tinymist/blob/31c3057ec2a9aed81f08256166d1ec2de2e0189a/tools/typst-preview-frontend/src/typst.css#L93)
- [Link hover handlers](https://github.com/Myriad-Dreamin/tinymist/blob/31c3057ec2a9aed81f08256166d1ec2de2e0189a/tools/typst-preview-frontend/src/typst.ts#L97)

The newer canvas preview also uses explicit interaction hit testing and a separate
highlight layer, rather than recompiling:
[interactions.ts](https://github.com/Myriad-Dreamin/tinymist/blob/31c3057ec2a9aed81f08256166d1ec2de2e0189a/tools/typst-preview-frontend-ng/src/interactions.ts#L366).

## Fit for this editor

Feasible with the existing `block_geometry`, `fetchDocumentLines`,
`selectionRectsFromBoxes`, and `svgPointFromClient` building blocks. No second
layout engine or compiler replacement is required.

This editor renders official `typst-svg` output and shares a master SVG through
`<use>` for Live cursor crops. Tinymist's custom text groups and glyph color
variables cannot be assumed to exist here; copying its CSS alone is insufficient.

A first implementation could cache text line boxes for the last successful render,
convert pointer coordinates into that render's coordinates, and draw a translucent
hover rectangle in the existing overlay. Crop offsets and scale must be respected
in split mode. Clear the highlight on leave, dragging, recompilation, and focus
changes. Mouse movement should use cached geometry, at most once per animation
frame, with no per-move IPC or compilation.

That reproduces a line-background highlight. Exact glyph recoloring additionally
needs identifiable text groups, or a clipped/masked color overlay, and must preserve
images, links, user colors, and the shared master SVG. Prefer choosing this extra
work deliberately rather than describing a background rectangle as identical.

Before generalizing, verify multi-column layouts: `cluster_into_boxes` currently
merges same-page text at the same baseline, potentially spanning column gaps.
Hit testing should account for both X and Y and avoid highlighting blank margins,
images, or stale geometry after a failed compile.

This is an investigation and implementation outline; hover behavior has not been
added to the app in this change.
