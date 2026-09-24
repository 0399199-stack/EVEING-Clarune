import type { SavedFile } from "../../../shared/image-tools";

export interface OutputHistoryEntry extends SavedFile { id: string; kind: "image" | "batch" | "pdf"; createdAt: string }
const KEY = "clarune.output-history.v1";
export function getOutputHistory(): OutputHistoryEntry[] {
  try {
    const entries: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(entries) ? entries.filter((entry): entry is OutputHistoryEntry => !!entry && typeof entry.path === "string" && typeof entry.createdAt === "string").slice(0, 100) : [];
  } catch { return []; }
}
export function recordOutputs(files: SavedFile[], kind: OutputHistoryEntry["kind"]) {
  const entries = files.map((file) => ({ ...file, id: crypto.randomUUID(), kind, createdAt: new Date().toISOString() }));
  try { localStorage.setItem(KEY, JSON.stringify([...entries, ...getOutputHistory()].slice(0, 100))); } catch { /* Exported files remain safe if local storage is full. */ }
  window.dispatchEvent(new Event("clarune:history-change"));
}
export function clearOutputHistory() { localStorage.removeItem(KEY); window.dispatchEvent(new Event("clarune:history-change")); }
