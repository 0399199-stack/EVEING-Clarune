import { describe, expect, it } from "vitest";
import { createWindowOptions } from "../src/shared/window-options";

describe("BrowserWindow security boundary", () => {
  it("keeps renderer isolation enabled", () => {
    const options = createWindowOptions("C:\\app\\preload.js", "win32");
    expect(options.webPreferences).toMatchObject({
      preload: "C:\\app\\preload.js",
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    });
  });

  it("uses native Windows glass material with a solid fallback color", () => {
    const options = createWindowOptions("C:\\app\\preload.js", "win32");
    expect(options.backgroundMaterial).toBe("mica");
    expect(options.backgroundColor).toBe("#edf8ff");
    expect(options.transparent).not.toBe(true);
  });
});
