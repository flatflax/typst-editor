import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

// Hardcoded per M0 scope (plan.md): prove Rust World + font bundling +
// compile_typst + SVG rendering before any editor UI exists.
const HARDCODED_TYPST_SOURCE = `
= Typst Editor — M0 Bootstrap

This SVG was produced by the *real* Typst compiler running inside the
Tauri Rust backend, not a reimplementation.

- Bold and _italic_ text
- \`inline code\`
- A bullet list item

+ An ordered list item
+ Another one
`;

type CompileDiagnostic = {
  severity: "error" | "warning";
  message: string;
};

type CompileResult = {
  svg: string | null;
  diagnostics: CompileDiagnostic[];
};

function App() {
  const [result, setResult] = useState<CompileResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<CompileResult>("compile_typst", { source: HARDCODED_TYPST_SOURCE })
      .then(setResult)
      .catch((err) => setError(String(err)));
  }, []);

  return (
    <main className="container">
      <h1>Typst Editor — M0</h1>
      <p>
        Source → <code>compile_typst</code> (Rust, real Typst engine) →
        rendered SVG preview.
      </p>

      {error && <p className="preview-error">Invoke failed: {error}</p>}

      {result?.diagnostics.map((d, i) => (
        <p key={i} className={`diagnostic diagnostic-${d.severity}`}>
          {d.severity}: {d.message}
        </p>
      ))}

      {result?.svg ? (
        <div className="preview" dangerouslySetInnerHTML={{ __html: result.svg }} />
      ) : (
        !error && <p>Compiling…</p>
      )}
    </main>
  );
}

export default App;
