import { load, type Store } from "@tauri-apps/plugin-store";

const STORE_FILE = "recent-files.json";
const RECENT_FILES_KEY = "recentFiles";
const MAX_RECENT_FILES = 10;

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  if (!storePromise) storePromise = load(STORE_FILE, { autoSave: true });
  return storePromise;
}

export async function getRecentFiles(): Promise<string[]> {
  const store = await getStore();
  return (await store.get<string[]>(RECENT_FILES_KEY)) ?? [];
}

/** Moves `path` to the front (de-duplicating) and caps the list length.
 * Returns the updated list so callers can update UI state without a second
 * round-trip through the store. */
export async function addRecentFile(path: string): Promise<string[]> {
  const store = await getStore();
  const existing = (await store.get<string[]>(RECENT_FILES_KEY)) ?? [];
  const next = [path, ...existing.filter((p) => p !== path)].slice(0, MAX_RECENT_FILES);
  await store.set(RECENT_FILES_KEY, next);
  return next;
}

export async function removeRecentFile(path: string): Promise<string[]> {
  const store = await getStore();
  const existing = (await store.get<string[]>(RECENT_FILES_KEY)) ?? [];
  const next = existing.filter((p) => p !== path);
  await store.set(RECENT_FILES_KEY, next);
  return next;
}
