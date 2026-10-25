# Preview hover highlighting: mechanism and implementation boundaries

Investigation: 2026-10-22. Conclusion: feasible, but not yet added to the application. Its priority is below this round's fixes, tab consolidation, and overall preview performance.

## How Tinymist works

The investigated SVG preview assigns `pointer-events: bounding-box` to text groups. On hover, it changes the CSS color variables used by glyph paths inside the group:

```css
.typst-text { pointer-events: bounding-box; cursor: text; }
.typst-text:hover { --glyph_fill: #f75c2f; --glyph_stroke: #f75c2f; }
```

The group's bounding box makes spaces between glyphs hit-testable, without recompiling on mouse movement. The effect resembles “a line changing color,” but its actual boundary is determined by the renderer's text grouping. Font or style changes may split a line into multiple groups, so it does not guarantee a whole visual line. Links have additional related-element hover handling; the newer canvas path uses hit testing and a separate highlight layer.

Pinned revision `31c3057ec2a9aed81f08256166d1ec2de2e0189a`: [SVG styles](https://github.com/Myriad-Dreamin/tinymist/blob/31c3057ec2a9aed81f08256166d1ec2de2e0189a/tools/typst-preview-frontend/src/typst.css#L93), [link handling](https://github.com/Myriad-Dreamin/tinymist/blob/31c3057ec2a9aed81f08256166d1ec2de2e0189a/tools/typst-preview-frontend/src/typst.ts#L97), and [canvas interaction](https://github.com/Myriad-Dreamin/tinymist/blob/31c3057ec2a9aed81f08256166d1ec2de2e0189a/tools/typst-preview-frontend-ng/src/interactions.ts#L366).

## A feasible path for this project

Existing `block_geometry`, `fetchDocumentLines`, `selectionRectsFromBoxes`, and coordinate conversions can be reused without replacing the compiler or building another layout engine. However, official typst-svg output does not guarantee Tinymist's groups or color variables, so its CSS cannot simply be copied.

An initial implementation can cache text-line boxes from the last successful rendering, convert mouse coordinates, and draw a translucent background in an overlay. Update at most once per animation frame, with no IPC or compilation during movement. Clear it on pointer exit, dragging, focus changes, or rendering updates; clipping mode must account for each block's origin and scale.

Background highlighting and glyph recoloring are different effects. Glyph recoloring requires stable text groups or clipping/mask-based coloring, while preserving images, links, and author-defined colors and remaining compatible with the shared master.

Acceptance priorities: hit-test both X and Y to avoid page margins and images; do not merge same-baseline text across columns; after compilation fails, do not highlight old output using new-source geometry. Current line clustering has multi-column limitations that should be addressed before broader use.
