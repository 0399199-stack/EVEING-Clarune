import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { OutputRegistry } from "../src/main/image-tools/output-registry";
import { isDevelopmentShortcut } from "../src/main/release-shortcuts";

describe("saved output access", () => {
  it("recovers bounded generated-output paths across restarts and rejects arbitrary paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clarune-output-registry-"));
    try {
      const store = join(dir, "saved.json"), first = new OutputRegistry(store);
      const paths = Array.from({ length: 502 }, (_, index) => join(dir, `${index}.png`));
      await first.remember([...paths, join(dir, "unsafe.exe"), "relative.png"]);
      const restored = new OutputRegistry(store);
      await expect(restored.resolve(paths[0])).rejects.toThrow("OUTPUT_NOT_FOUND");
      expect(await restored.resolve(paths[501])).toBe(paths[501]);
      await expect(restored.resolve(join(dir, "unsafe.exe"))).rejects.toThrow("INVALID_OPTIONS");
      await writeFile(store, "not JSON");
      await expect(new OutputRegistry(store).resolve(paths[501])).rejects.toThrow("OUTPUT_NOT_FOUND");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("blocks release reload/devtools shortcuts but leaves editing/zoom keys alone", () => {
    const key = (value: string, control = false, shift = false, meta = false) => isDevelopmentShortcut({ key: value, control, shift, meta });
    for (const value of ["F5", "F12"]) expect(key(value)).toBe(true);
    expect(key("r", true)).toBe(true);
    expect(key("R", false, true, true)).toBe(true);
    expect(key("I", true, true)).toBe(true);
    expect(key("c", true)).toBe(false);
    expect(key("+", true)).toBe(false);
    expect(key("r")).toBe(false);
  });
});
