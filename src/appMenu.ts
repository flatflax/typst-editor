// Native application menu (Tauri: a per-window menu bar on Windows/Linux, a
// global menubar on macOS) for file operations — replaces the old in-content
// Open/Save/Save As/Export PDF/recent-files buttons per the user's request
// ("tools like open, save... should move to top menu"). Accelerators shown
// here are authoritative: App.tsx no longer has its own keydown listener for
// the same shortcuts, to avoid double-firing between the native menu and a
// DOM-level handler.
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { basename } from "./fileIO";

export type AppMenuActions = {
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onExportPdf: () => void;
  onOpenRecent: (path: string) => void;
};

// Rebuilt (not just updated in place) whenever `recentFiles` changes — the
// "Open Recent" submenu's items are fixed at construction time, and full
// rebuilds are cheap enough at this scale (a handful of menu items, only on
// a load/save, not on every keystroke).
export async function buildAppMenu(recentFiles: string[], actions: AppMenuActions): Promise<Menu> {
  const recentItems =
    recentFiles.length > 0
      ? await Promise.all(
          recentFiles.map((path) =>
            MenuItem.new({ text: basename(path), action: () => actions.onOpenRecent(path) }),
          ),
        )
      : [await MenuItem.new({ text: "No Recent Files", enabled: false })];

  const fileMenu = await Submenu.new({
    text: "File",
    items: [
      await MenuItem.new({ text: "Open…", accelerator: "CmdOrCtrl+O", action: () => actions.onOpen() }),
      await MenuItem.new({ text: "Save", accelerator: "CmdOrCtrl+S", action: () => actions.onSave() }),
      await MenuItem.new({
        text: "Save As…",
        accelerator: "CmdOrCtrl+Shift+S",
        action: () => actions.onSaveAs(),
      }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await Submenu.new({ text: "Open Recent", items: recentItems }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({ text: "Export PDF…", action: () => actions.onExportPdf() }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await PredefinedMenuItem.new({ item: "Quit" }),
    ],
  });

  // A Menu used as the app/window menu bar can only contain Submenus
  // (Tauri's own constraint on Windows/macOS) — "File" is the only one for
  // now; formatting tools (bold/table/image/...) stay in WysiwygEditor's
  // inline toolbar, which is a content-editing surface, not a file operation.
  return Menu.new({ items: [fileMenu] });
}
