import { readFile, rename, writeFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { ImageToolError } from "./processor";

const validPath = (value: unknown): value is string => typeof value === "string" && value.length < 32_768 && isAbsolute(value) && [".png", ".jpg", ".jpeg", ".webp", ".pdf"].includes(extname(value).toLowerCase());
const key = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

/** Only paths produced by this app may be revealed/copied through the renderer bridge. */
export class OutputRegistry {
  private paths = new Map<string, string>();
  private pending = Promise.resolve();
  private ready: Promise<void>;

  constructor(private storagePath?: string) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    if (!this.storagePath) return;
    try {
      const bytes = await readFile(this.storagePath);
      if (bytes.length > 2 * 1024 * 1024) return;
      const entries: unknown = JSON.parse(bytes.toString("utf8"));
      if (Array.isArray(entries)) for (const path of entries.slice(-500)) if (validPath(path)) this.paths.set(key(path), path);
    } catch { /* Missing/unreadable history must never prevent saving an image. */ }
  }

  async remember(paths: string[]): Promise<void> {
    await this.ready;
    for (const path of paths) {
      if (!validPath(path)) continue;
      this.paths.delete(key(path));
      this.paths.set(key(path), path);
    }
    while (this.paths.size > 500) this.paths.delete(this.paths.keys().next().value!);
    if (!this.storagePath) return;
    const snapshot = JSON.stringify([...this.paths.values()]);
    this.pending = this.pending.then(async () => {
      const temporary = `${this.storagePath}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, this.storagePath!);
    }).catch(() => undefined);
    await this.pending;
  }

  async resolve(value: unknown): Promise<string> {
    await this.ready;
    if (!validPath(value)) throw new ImageToolError("INVALID_OPTIONS");
    const path = this.paths.get(key(value));
    if (!path) throw new ImageToolError("OUTPUT_NOT_FOUND");
    return path;
  }
}
