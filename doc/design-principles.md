# Design principles

Document review: 2026-10-23. The following rules apply to subsequent implementation; conclusions from early approaches are superseded by the current interaction mechanism. See [Interaction design §6](interaction-design.md#6-核心交互机制聚焦块编辑源码) for actionable behavior requirements and [Phase 4](phase4-product-validation.md#validation-levels-and-existing-records) for validation records.

## 1. Reuse editing operations first

Before adding a content capability, determine whether existing operations can serve it, rather than adding a separate parser, serializer, and control for every Typst construct.

- Raw-source preservation: `unsupported_block`, `typst_call`, and `typst_set`.
- Composable recursive marks: for example, normalizing links and existing styles through `addToSet`.
- Recursive containers: table cells and body content reuse block/inline serialization.
- Structural transformations: parse into a ProseMirror document, execute existing commands, and serialize; Live cursor does not require a permanently mounted ProseMirror editing DOM.

An operation is worth introducing as a new primitive only if it can serve a class of future needs.

Reuse does not mean putting every conversion in one dispatch table. Inline leaf conversions are usually one-to-one and context-free, making centralized definitions suitable. Block conversions may inspect siblings, hoist top-level settings, identify standalone images, or validate table shapes; they should retain explicit contextual handling. M13 reduced duplication while preserving these differences, rather than hiding different semantics behind a uniform form.

## 2. Typst handles layout; the editing system handles interaction

Unfocused content displays Typst's actual compiled output. Custom cursors, selections, and click positions must correspond to the same source and layout geometry; another layout system must not determine those pixel positions.

In Live cursor, the focused block explicitly displays editable source. A native textarea handles input, IME, local selection, and local undo; the source textarea is not presented as final layout. Constructs without visible geometry, such as `#let` and `#set`, can also be edited through source entry points or definition navigation. Geometry is not a prerequisite for editable source.

Handle three kinds of need separately:

| Content | Required capability |
|---|---|
| Variable, rule, and label declarations | Semantic positioning, definition navigation, and scope; usage-to-definition navigation is partially implemented, while reverse navigation and rule-effect ranges remain pending |
| Comments and unknown syntax | Preserve raw source without silently discarding it |
| Frequently used visible content, such as equations | Specialized structural editing can be added gradually, with Typst remaining responsible for layout |

## 3. Advance input, saving, and preview independently

Native draft input must not wait for Rust geometry queries or compilation. Drafts must immediately participate in dirty-state checks, saving, and export; whether to commit them for compilation is a separate decision. Do not autosave intermediate text during IME composition.

Every asynchronous result must match the document, directory, and source version. Do not clip an old SVG using geometry from new source, or let an old save request mark a new document as saved. Focus requests and saves currently have corresponding safeguards; the new workspace compilation scheduler and page-version protocol still need coverage of real error recovery and concurrency scenarios.

## 4. Correctness and evidence

- Do not sacrifice layout precision, source preservation, undo, or IME behavior for performance.
- Distinguish “code exists,” “tests passed,” “native acceptance passed,” and “user needs validated”; mocked-backend tests cannot establish system-clipboard or real-layout correctness.
- Judge preview performance by overall commitment-to-display latency; a compilation-only measurement cannot close the reported lag issue.
- Keep a path to improvement in simple implementations; choices such as autosaving directly to the real file must state their recovery limits.

Documentation needs maintained constraints just as implementation does: status summaries cannot replace interaction specifications, milestone numbers cannot replace comparisons of goals and results, and test totals cannot replace acceptance evidence. When removing repeated prose, preserve preconditions, event outcomes, failure paths, ownership of unfinished items, and reproduction entry points. If an original statement overclaims, document the evidence gap rather than restoring it as a proven fact.

## Evolution of the rules

Phase 3 initially tried to join ProseMirror's editing layout and Typst's paginated layout in the same area. M15's three experiments exposed DOM reconciliation, cursor, and layout-transition problems, and that mechanism was not adopted. M20–M22 validated interaction drawn from Typst geometry; Phase 4 then returned ordinary single-block input to a native textarea, leaving custom interaction primarily for cross-block selection.

The earlier judgment that “constructs without geometry can only be edited in an inspector” has been superseded by Live cursor's source-editing approach. See [Phase 3](phase3-single-view.md) for the full experimental basis and [Interaction design](interaction-design.md) for product tradeoffs.
