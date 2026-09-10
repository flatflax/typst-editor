// Phase 4 Spike 1 (doc/phase4-product-validation.md, doc/interaction-design.md
// §6/§10): does the core "focus reveals source" swap feel right at all,
// before building anything further on top of it? One paragraph only, no
// cross-block selection, no lazy-vs-eager split debate (Spike 3), no
// `unsupported_block` fallback for unparsable text — none of that is what
// this call is trying to answer. Throwaway code per the project's own
// definition of a spike (interaction-design.md footnote 44): stop as soon as
// the answer is felt, don't chase completeness or edge cases.
//
// Deliberately NOT built on TypstLiveView's self-drawn-caret machinery
// (`block_geometry`/`jump_from_click`, M20) — that machinery exists to
// answer a different question (cross-block editing on live geometry). This
// spike swaps real DOM nodes instead: a rendered `<div>` (real Typst SVG)
// on blur, a real `<textarea>` (native focus, caret, IME, undo — all free)
// on focus. That swap, and how it feels, *is* the thing being tested.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { EditorDiagnostic } from "./SourceEditor";

const SPIKE_INITIAL_SOURCE =
  "This is *one* paragraph. Click or tab into it to reveal its raw Typst " +
  "source in a native text box; click or tab away to see it re-render.";

type CompileResult = {
  svg: string | null;
  diagnostics: EditorDiagnostic[];
  page_offsets_pt: number[];
};

type Props = {
  documentDir: string | null;
};

const FocusRevealSpike = ({ documentDir }: Props) => {
  // `source` only changes on blur (see `commitEdit` below) — never on every
  // keystroke — because §6/§5D's whole point is that typing inside the
  // focused block must be fully decoupled from Typst compilation. A
  // recompile-per-keystroke here would silently reintroduce the exact
  // coupling this spike exists to get rid of.
  const [source, setSource] = useState(SPIKE_INITIAL_SOURCE);
  const [editing, setEditing] = useState(false);
  const [svg, setSvg] = useState<string | null>(null);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const renderedRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef(source);
  // Same fix TypstLiveView.tsx already needed for the same
  // `dangerouslySetInnerHTML` pattern: replacing the rendered SVG's markup
  // resets an ancestor scroll container's `scrollTop` back to 0 — found
  // live-testing here too, not just there. Tracks the latest scroll
  // position on every native scroll event and restores it in a *layout*
  // effect (runs before paint) keyed on `svg`, so any reset that happens
  // during that commit is corrected before it's visible.
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const lastScrollRef = useRef({ top: 0, left: 0 });

  function handleContainerScroll(event: React.UIEvent<HTMLDivElement>) {
    lastScrollRef.current = { top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft };
  }

  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (el) {
      el.scrollTop = lastScrollRef.current.top;
      el.scrollLeft = lastScrollRef.current.left;
    }
  }, [svg]);
  // The rendered state sits at the compiled Typst page's own width (it
  // never stretches wider than that, however wide the window is) — the
  // textarea has no such natural width of its own. Confirmed live on a
  // 1080p fullscreen window: without locking it to match, focusing snapped
  // the box from page-width straight to full-window-width, which read as
  // "the box became huge" even though height was already capped. Measured
  // once per focus (not tracked continuously — Spike 1 doesn't need to
  // survive a mid-edit window resize) and applied as the textarea's actual
  // width, so the swap itself doesn't move the box at all.
  const lockedWidthPxRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCompiling(true);
    // `#set page(height: auto)`: compiling this one paragraph completely
    // alone, with no page override, would otherwise get Typst's default
    // *full* page height (A4-ish) — mostly blank space below the actual
    // line of text. Found live-testing Spike 2 (same isolated-compile
    // pattern, but with a sibling block whose oversized height visibly
    // pushed the focused textarea down the page) — applies equally here,
    // just less obvious with only one block to look at. Compile-only:
    // never touches `source`/`draftRef`, so it can't leak into anything
    // that edits or commits the real text.
    invoke<CompileResult>("compile_typst", { source: `#set page(height: auto)\n${source}`, baseDir: documentDir })
      .then((result) => {
        if (cancelled) return;
        setSvg(result.svg);
        setCompileError(result.diagnostics.find((d) => d.severity === "error")?.message ?? null);
      })
      .catch((err) => {
        if (!cancelled) setCompileError(String(err));
      })
      .finally(() => {
        if (!cancelled) setCompiling(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source, documentDir]);

  function autosize(el: HTMLTextAreaElement) {
    // "自由增高的文本编辑区" (§6) — a plain textarea doesn't grow with its
    // content on its own; resetting height before reading scrollHeight is
    // the standard trick (otherwise scrollHeight only ever grows, never
    // shrinks back down after deleting a line).
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  function startEditing() {
    // NOT `renderedRef.current`'s own width — that outer `<div>` is a
    // plain block box (`width: auto`), which fills the *entire* available
    // column regardless of what's inside it, same as the textarea does.
    // The actual visible ink sits at the compiled `<svg>`'s own natural
    // width (`max-width: 100%` caps it, nothing stretches it to fill extra
    // space) — that inner element is the one whose width needs matching.
    const svgEl = renderedRef.current?.querySelector("svg");
    lockedWidthPxRef.current = svgEl?.getBoundingClientRect().width ?? null;
    draftRef.current = source;
    setEditing(true);
  }

  // `useLayoutEffect`, not `useEffect`: sizing must land before the browser
  // paints the freshly-mounted textarea, or the box briefly flashes at its
  // native ~2-row default and visibly snaps to the right height a frame
  // later.
  useLayoutEffect(() => {
    if (!editing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    // NOT `el.select()`: selecting the full text on focus means the very
    // next keystroke — Enter included — replaces the *entire* paragraph
    // instead of extending it. Confirmed live: that's exactly what made
    // "press Enter, type a new line" look like it silently ate the original
    // content instead of adding to it. Landing the caret at the end matches
    // "keep going from where you left off" without destroying anything.
    el.setSelectionRange(el.value.length, el.value.length);
    autosize(el);
  }, [editing]);

  function commitEdit() {
    setEditing(false);
    if (draftRef.current !== source) setSource(draftRef.current);
  }

  return (
    <div className="spike-focus-reveal" ref={scrollContainerRef} onScroll={handleContainerScroll}>
      <p className="scope-note">
        Phase 4 Spike 1: click into the paragraph below (or Tab to it) to reveal its raw Typst source in a native
        text box — native caret, undo, IME preview, copy/paste, all free. Click or Tab away to re-render it for
        real, through the same Typst compiler as every other view.
      </p>
      {editing ? (
        <textarea
          ref={textareaRef}
          className="spike-source-textarea"
          // `undefined` (no inline width) falls back to the CSS 100% rule
          // only if nothing was measurable — e.g. `svg` was still null the
          // first time this ever mounts. `max-width: 100%` in CSS still
          // clamps this down if the window is later resized narrower.
          style={lockedWidthPxRef.current != null ? { width: lockedWidthPxRef.current } : undefined}
          defaultValue={source}
          onChange={(event) => {
            draftRef.current = event.currentTarget.value;
            autosize(event.currentTarget);
          }}
          onBlur={commitEdit}
          onKeyDown={(event) => {
            // Escape just leaves source mode — it does NOT discard the
            // draft. An earlier version reset it first, reading as a
            // natural "cancel"; confirmed live that it instead reads as
            // silent data loss, since nothing else about this textarea
            // hints that Escape is special — every other exit (click away,
            // Tab) keeps what you typed. `commitEdit` runs the same way
            // blur always does.
            if (event.key === "Escape") event.currentTarget.blur();
          }}
        />
      ) : (
        <div
          ref={renderedRef}
          className="spike-rendered"
          tabIndex={0}
          onFocus={startEditing}
          onClick={startEditing}
          aria-label="Focus to edit source"
        >
          {svg ? (
            <div className={compiling ? "spike-rendered-svg is-compiling" : "spike-rendered-svg"} dangerouslySetInnerHTML={{ __html: svg }} />
          ) : (
            <p className="spike-placeholder">{compiling ? "Compiling…" : "(empty)"}</p>
          )}
        </div>
      )}
      {compileError && <p className="diagnostic diagnostic-error">{compileError}</p>}
    </div>
  );
};

export default FocusRevealSpike;
