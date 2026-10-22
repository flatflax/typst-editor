// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  write: vi.fn(),
  read: vi.fn(),
  ask: vi.fn(),
  save: vi.fn(),
  menu: {} as Record<string, (...args: string[]) => void>,
  close: undefined as undefined | ((event: { preventDefault: () => void }) => Promise<void>),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readTextFile: mocks.read, writeTextFile: mocks.write }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: mocks.ask, open: vi.fn(), save: mocks.save }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({
  setTitle: vi.fn(async () => {}),
  onCloseRequested: vi.fn(async (callback) => { mocks.close = callback; return () => {}; }),
}) }));
vi.mock("./shell/recentFiles", () => ({
  getRecentFiles: async () => [], addRecentFile: async () => [], removeRecentFile: async () => [],
}));
vi.mock("./shell/appMenu", () => ({ buildAppMenu: async (_recent: unknown, actions: typeof mocks.menu) => {
  mocks.menu = actions;
  return { setAsAppMenu: async () => {} };
} }));
vi.mock("./editor/WysiwygEditor", () => ({ default: () => null }));
vi.mock("./editor/SourceEditor", () => ({ default: () => null }));
vi.mock("./util/svgGeometry", () => ({
  svgPointFromClient: (_svg: unknown, x: number, y: number) => ({ xPt: x, yPt: y }),
  clientPointFromPt: (_svg: unknown, x: number, y: number) => ({ clientX: x, clientY: y }),
}));

let host: HTMLDivElement;
let root: Root;
const source = "中文 *one*\n\nsecond🙂\n\nthird";
const bytes = (text: string) => new TextEncoder().encode(text).length;

async function settle(action?: () => void) {
  await act(async () => { action?.(); });
}

async function tick(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

async function mouse(target: Element, name: string, byteOffset: number) {
  await settle(() => target.dispatchEvent(new MouseEvent(name, { bubbles: true, clientX: byteOffset, clientY: 20 })));
}

async function focusFirstBlock(byteOffset = 0) {
  const stage = host.querySelector(".typst-live-stage")!;
  await mouse(stage, "mousedown", byteOffset);
  await mouse(stage, "mouseup", byteOffset);
  return host.querySelector<HTMLTextAreaElement>(".typst-live-block-textarea")!;
}

async function typeDraft(textarea: HTMLTextAreaElement, text: string, composing = false) {
  await settle(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text, isComposing: composing }));
  });
}

async function selectAcrossBlocks(reverse = false) {
  const stage = host.querySelector(".typst-live-stage")!;
  const end = bytes("中文 *one*\n\nsecond🙂");
  await mouse(stage, "mousedown", reverse ? end : 0);
  await mouse(stage, "mousemove", reverse ? 0 : end);
  await mouse(stage, "mouseup", reverse ? 0 : end);
  return host.querySelector<HTMLTextAreaElement>(".typst-live-hidden-input")!;
}

async function clipboard(target: Element, type: string, text = "") {
  const data = new Map<string, string>([["text/plain", text]]);
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: {
    types: ["text/plain"],
    setData: (mime: string, value: string) => data.set(mime, value),
    getData: (mime: string) => data.get(mime) ?? "",
  } });
  await settle(() => target.dispatchEvent(event));
  return { event, text: data.get("text/plain") };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  mocks.invoke.mockReset().mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "parse_typst_ast") return { settings: [], content: [{ type: "paragraph", children: [{ type: "text", text: String(args.source), marks: [] }] }] };
    if (command === "compile_typst") return { svg: `<svg viewBox="0 0 600 800" width="600" height="800"><g data-source="${String(args.source).length}"/></svg>`, diagnostics: [], page_offsets_pt: [0] };
    if (command === "jump_from_click") return args.xPt;
    if (command === "block_geometry") return (args.ranges as number[][]).map(() => [{ page: 1, x_pt: 20, y_top_pt: 20, width_pt: 100, height_pt: 14, baseline_from_top_pt: 10 }]);
    if (command === "find_block_references") return [];
    throw new Error(`Unexpected command: ${command}`);
  });
  mocks.write.mockReset().mockResolvedValue(undefined);
  mocks.read.mockReset().mockResolvedValue(source);
  mocks.ask.mockReset().mockResolvedValue(false);
  mocks.save.mockReset().mockResolvedValue("C:/docs/export.pdf");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await settle(() => root.render(<App />));
  await settle(() => Array.from(host.querySelectorAll<HTMLButtonElement>("[role=tab]")).find((button) => button.textContent?.startsWith("Live cursor"))!.click());
  await settle(() => mocks.menu.onOpenRecent("C:/docs/test.typ"));
  await tick(200);
});

afterEach(async () => {
  await settle(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Live cursor draft persistence", () => {
  it("saves a later block without shifting past preceding CJK and emoji", async () => {
    const textarea = await focusFirstBlock(bytes("中文 *one*\n\nsecond🙂\n\n"));
    expect(textarea.value).toBe("third");
    await typeDraft(textarea, "末段🙂");
    await settle(() => mocks.menu.onSave());
    expect(mocks.write).toHaveBeenLastCalledWith("C:/docs/test.typ", "中文 *one*\n\nsecond🙂\n\n末段🙂");
  });

  it("saves an unblurred draft verbatim without compiling it or losing focus", async () => {
    const textarea = await focusFirstBlock();
    const compiles = mocks.invoke.mock.calls.filter(([command]) => command === "compile_typst").length;
    await typeDraft(textarea, "草稿  *unfinished");
    await tick(200);
    expect(host.querySelector(".file-title")!.textContent).toContain("•");
    await settle(() => mocks.menu.onSave());
    expect(mocks.write).toHaveBeenLastCalledWith("C:/docs/test.typ", "草稿  *unfinished\n\nsecond🙂\n\nthird");
    expect(document.activeElement).toBe(textarea);
    expect(host.querySelector(".file-title")!.textContent).not.toContain("•");
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "compile_typst")).toHaveLength(compiles);
    await typeDraft(textarea, "another draft");
    expect(host.querySelector(".file-title")!.textContent).toContain("•");
  });

  it("autosaves while a block stays focused and does not save an intermediate IME composition", async () => {
    const textarea = await focusFirstBlock();
    await typeDraft(textarea, "拼音", true);
    await tick(2500);
    expect(mocks.write).not.toHaveBeenCalled();
    await settle(() => textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "拼音" })));
    await tick(1999);
    expect(mocks.write).not.toHaveBeenCalled();
    await tick(1);
    expect(mocks.write).toHaveBeenCalledWith("C:/docs/test.typ", "拼音\n\nsecond🙂\n\nthird");
    expect(document.activeElement).toBe(textarea);
  });

  it("includes an unblurred draft in export and close protection", async () => {
    const textarea = await focusFirstBlock();
    await typeDraft(textarea, "export me");
    await settle(() => mocks.menu.onExportPdf());
    expect(mocks.invoke).toHaveBeenCalledWith("export_pdf", expect.objectContaining({ source: "export me\n\nsecond🙂\n\nthird" }));
    const preventDefault = vi.fn();
    await act(async () => { await mocks.close!({ preventDefault }); });
    expect(mocks.ask).toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalled();
  });

  it("honors composition events even when an input incorrectly reports isComposing=false", async () => {
    const textarea = await focusFirstBlock();
    await settle(() => textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await typeDraft(textarea, "组合中", false);
    await tick(2500);
    expect(mocks.write).not.toHaveBeenCalled();
    await settle(() => textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "组合中" })));
    await tick(2000);
    expect(mocks.write).toHaveBeenCalledWith("C:/docs/test.typ", "组合中\n\nsecond🙂\n\nthird");
  });

  it("does not mark newer typing clean when an older save finishes", async () => {
    const textarea = await focusFirstBlock();
    await typeDraft(textarea, "first");
    let finish!: () => void;
    mocks.write.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await settle(() => mocks.menu.onSave());
    await typeDraft(textarea, "second");
    await settle(() => finish());
    expect(host.querySelector(".file-title")!.textContent).toContain("•");
    await tick(2000);
    expect(mocks.write).toHaveBeenLastCalledWith("C:/docs/test.typ", "second\n\nsecond🙂\n\nthird");
  });

  it("keeps a failed save dirty and allows retry without blurring", async () => {
    const textarea = await focusFirstBlock();
    await typeDraft(textarea, "retry me");
    mocks.write.mockRejectedValueOnce(new Error("disk full"));
    await settle(() => mocks.menu.onSave());
    expect(host.textContent).toContain("disk full");
    expect(host.querySelector(".file-title")!.textContent).toContain("•");
    await settle(() => mocks.menu.onSave());
    expect(mocks.write).toHaveBeenLastCalledWith("C:/docs/test.typ", "retry me\n\nsecond🙂\n\nthird");
    expect(host.querySelector(".file-title")!.textContent).not.toContain("•");
    expect(document.activeElement).toBe(textarea);
  });

  it("serializes overlapping saves in request order", async () => {
    const textarea = await focusFirstBlock();
    await typeDraft(textarea, "older");
    let finish!: () => void;
    mocks.write.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await settle(() => mocks.menu.onSave());
    await typeDraft(textarea, "newer");
    await settle(() => mocks.menu.onSave());
    expect(mocks.write).toHaveBeenCalledTimes(1);
    await settle(() => finish());
    expect(mocks.write).toHaveBeenCalledTimes(2);
    expect(mocks.write).toHaveBeenLastCalledWith("C:/docs/test.typ", "newer\n\nsecond🙂\n\nthird");
    expect(host.querySelector(".file-title")!.textContent).not.toContain("•");
  });

  it("does not apply an old save's baseline to a newly opened document", async () => {
    const textarea = await focusFirstBlock();
    await typeDraft(textarea, "old file");
    let finish!: () => void;
    mocks.write.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await settle(() => mocks.menu.onSave());
    mocks.ask.mockResolvedValueOnce(true);
    mocks.read.mockResolvedValueOnce("different document");
    await settle(() => mocks.menu.onOpenRecent("C:/docs/new.typ"));
    await settle(() => finish());
    expect(host.querySelector(".file-title")!.textContent).toBe("new.typ");
  });

  it("does not discard an unblurred draft when opening another file is cancelled", async () => {
    const textarea = await focusFirstBlock();
    await typeDraft(textarea, "keep me");
    mocks.read.mockClear();
    await settle(() => mocks.menu.onOpenRecent("C:/docs/new.typ"));
    expect(mocks.read).not.toHaveBeenCalled();
    expect(textarea.value).toBe("keep me");
    expect(host.querySelector(".file-title")!.textContent).toBe("test.typ •");
  });

  it("remains clean when the saved draft later commits on blur", async () => {
    const textarea = await focusFirstBlock();
    await typeDraft(textarea, "already saved");
    await settle(() => mocks.menu.onSave());
    await settle(() => textarea.blur());
    expect(host.querySelector(".file-title")!.textContent).not.toContain("•");
  });
});

describe("Live cursor cross-block clipboard", () => {
  it.each([false, true])("copies literal Typst, CJK and emoji in either selection direction (reverse=%s)", async (reverse) => {
    const input = await selectAcrossBlocks(reverse);
    const result = await clipboard(input, "copy");
    expect(result.event.defaultPrevented).toBe(true);
    expect(result.text).toBe("中文 *one*\n\nsecond🙂");
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("cuts as one undoable edit and supports redo", async () => {
    const input = await selectAcrossBlocks();
    expect((await clipboard(input, "cut")).text).toBe("中文 *one*\n\nsecond🙂");
    await settle(() => mocks.menu.onSave());
    expect(mocks.write).toHaveBeenLastCalledWith("C:/docs/test.typ", "\n\nthird");
    await settle(() => input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "z" })));
    await settle(() => mocks.menu.onSave());
    expect(mocks.write).toHaveBeenLastCalledWith("C:/docs/test.typ", source);
    await settle(() => input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "y" })));
    await settle(() => mocks.menu.onSave());
    expect(mocks.write).toHaveBeenLastCalledWith("C:/docs/test.typ", "\n\nthird");
  });

  it("pastes plain text over a cross-block selection exactly once", async () => {
    const input = await selectAcrossBlocks();
    const result = await clipboard(input, "paste", "替换🙂\n\nnew block");
    expect(result.event.defaultPrevented).toBe(true);
    await settle(() => mocks.menu.onSave());
    expect(mocks.write).toHaveBeenLastCalledWith("C:/docs/test.typ", "替换🙂\n\nnew block\n\nthird");
  });

  it("leaves native single-block copying alone", async () => {
    const textarea = await focusFirstBlock();
    const result = await clipboard(textarea, "copy");
    expect(result.event.defaultPrevented).toBe(false);
  });

  it("keeps typing after a paste in a separate undo step", async () => {
    const input = await selectAcrossBlocks();
    await clipboard(input, "paste", "replacement");
    await settle(() => input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "x" })));
    await settle(() => input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "z" })));
    await settle(() => mocks.menu.onSave());
    expect(mocks.write).toHaveBeenLastCalledWith("C:/docs/test.typ", "replacement\n\nthird");
    await settle(() => input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "z" })));
    await settle(() => mocks.menu.onSave());
    expect(mocks.write).toHaveBeenLastCalledWith("C:/docs/test.typ", source);
  });

  it("does not copy or cut when the cross-block cursor has no selection", async () => {
    const input = host.querySelector<HTMLTextAreaElement>(".typst-live-hidden-input")!;
    expect((await clipboard(input, "copy")).event.defaultPrevented).toBe(false);
    expect((await clipboard(input, "cut")).event.defaultPrevented).toBe(false);
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
