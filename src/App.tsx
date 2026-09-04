import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import SourceEditor, { type SourceEditorHandle } from "./SourceEditor";
import { byteToUtf16Offset, utf16ToByteOffset } from "./offsets";
import "./App.css";

const INITIAL_SOURCE = `= Typst Editor — M1

Edit this *Typst* source on the left; the preview on the right recompiles
automatically via the real Typst compiler.

- Click anywhere in the preview to jump the cursor to that spot in the source
- Move the cursor in the source to see the matching point highlighted below

+ Bullet and numbered lists
+ \`inline code\`
`;

const COMPILE_DEBOUNCE_MS = 250;

type CompileDiagnostic = {
  severity: "error" | "warning";
  message: string;
};

type CompileResult = {
  svg: string | null;
  diagnostics: CompileDiagnostic[];
};

type CursorTarget = {
  page: number;
  x_pt: number;
  y_pt: number;
};

function svgPointFromClient(svg: SVGSVGElement, clientX: number, clientY: number) {
  const rect = svg.getBoundingClientRect();
  const viewBox = svg.viewBox.baseVal;
  return {
    xPt: ((clientX - rect.left) / rect.width) * viewBox.width,
    yPt: ((clientY - rect.top) / rect.height) * viewBox.height,
  };
}

function clientPointFromPt(svg: SVGSVGElement, xPt: number, yPt: number) {
  const rect = svg.getBoundingClientRect();
  const viewBox = svg.viewBox.baseVal;
  return {
    clientX: rect.left + (xPt / viewBox.width) * rect.width,
    clientY: rect.top + (yPt / viewBox.height) * rect.height,
  };
}


function App() {
  const [source, setSource] = useState(INITIAL_SOURCE);
  const [result, setResult] = useState<CompileResult | null>(null);
  const [invokeError, setInvokeError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<{ clientX: number; clientY: number } | null>(null);

  const editorRef = useRef<SourceEditorHandle | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;

  // Debounced Typst source -> compile_typst -> SVG preview loop (plan.md M1).
  useEffect(() => {
    const timer = setTimeout(() => {
      invoke<CompileResult>("compile_typst", { source })
        .then(setResult)
        .catch((err) => setInvokeError(String(err)));
    }, COMPILE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [source]);

  function handlePreviewClick(event: React.MouseEvent<HTMLDivElement>) {
    const svg = previewRef.current?.querySelector("svg");
    if (!svg) return;
    const { xPt, yPt } = svgPointFromClient(svg, event.clientX, event.clientY);
    invoke<number | null>("jump_from_click", { source: sourceRef.current, xPt, yPt })
      .then((byteOffset) => {
        if (byteOffset != null) {
          editorRef.current?.setCursor(byteToUtf16Offset(sourceRef.current, byteOffset));
        }
      })
      .catch((err) => setInvokeError(String(err)));
  }

  function handleCursorChange(utf16Offset: number) {
    const svg = previewRef.current?.querySelector("svg");
    if (!svg) return;
    const cursor = utf16ToByteOffset(sourceRef.current, utf16Offset);
    invoke<CursorTarget[]>("jump_from_cursor", { source: sourceRef.current, cursor })
      .then((targets) => {
        const target = targets[0];
        if (!target) {
          setHighlight(null);
          return;
        }
        setHighlight(clientPointFromPt(svg, target.x_pt, target.y_pt));
      })
      .catch(() => setHighlight(null));
  }

  return (
    <main className="app">
      <header className="app-header">
        <h1>Typst Editor — M1</h1>
        <p>Typst source → real Typst compiler → live SVG preview, with click/cursor sync.</p>
      </header>

      {invokeError && <p className="preview-error">Invoke failed: {invokeError}</p>}

      <div className="workspace">
        <SourceEditor
          ref={editorRef}
          initialValue={source}
          onChange={setSource}
          onCursorChange={handleCursorChange}
        />

        <div className="preview-pane">
          {result?.diagnostics.map((d, i) => (
            <p key={i} className={`diagnostic diagnostic-${d.severity}`}>
              {d.severity}: {d.message}
            </p>
          ))}

          <div
            ref={previewRef}
            className="preview"
            onClick={handlePreviewClick}
            dangerouslySetInnerHTML={{ __html: result?.svg ?? "" }}
          />

          {highlight && (
            <div
              className="cursor-marker"
              style={{ left: highlight.clientX, top: highlight.clientY }}
            />
          )}
        </div>
      </div>
    </main>
  );
}

export default App;
