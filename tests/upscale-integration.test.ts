import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { processImage, writeNewFile } from "../src/main/image-tools/processor";
import { configureUpscaleRuntime, getUpscaleStatus, selectUpscaleRuntime, upscaleImage } from "../src/main/upscale/runtime";
import type { UpscaleOptions } from "../src/shared/image-tools";

// Opt-in hardware test: use an externally installed, pinned runtime, never ship
// the runtime/models or write to the user's real Clarune profile.
describe.skipIf(!process.env.CLARUNE_REAL_AI_RUNTIME)("real external AI runtime", () => {
  it("detects only a verified known local runtime and never overrides an invalid explicit choice", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clarune-ai-discovery-"));
    const registry = join(directory, "runtime.json");
    configureUpscaleRuntime(registry, [process.env.CLARUNE_REAL_AI_RUNTIME!]);
    expect(await getUpscaleStatus()).toMatchObject({ ready: true, localOnly: true, source: "detected" });
    expect(await readdir(directory)).toEqual([]);
    await writeFile(registry, JSON.stringify({ directory }));
    configureUpscaleRuntime(registry, [process.env.CLARUNE_REAL_AI_RUNTIME!]);
    expect(await getUpscaleStatus()).toMatchObject({ ready: false, reason: "UPSCALE_RUNTIME_UNVERIFIED" });
    await writeFile(registry, "invalid json");
    configureUpscaleRuntime(registry, [process.env.CLARUNE_REAL_AI_RUNTIME!]);
    expect((await getUpscaleStatus()).ready).toBe(false);
  });
  it("reports genuine native progress and cancels an owned running inference before cleaning its files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clarune-ai-cancel-validation-"));
    configureUpscaleRuntime(join(directory, "runtime.json"), [process.env.CLARUNE_REAL_AI_RUNTIME!]);
    expect((await getUpscaleStatus()).ready).toBe(true);
    const source = await sharp({ create: { width: 256, height: 192, channels: 4, background: "red" } }).png().toBuffer();
    const before = (await readdir(tmpdir())).filter((name) => name.startsWith("clarune-ai-")).sort();
    const abort = new AbortController();
    const percentages: number[] = [];
    await expect(upscaleImage(source, 256, 192, { scale: 4, model: "realesrgan-x4plus", tileSize: 128 }, { signal: abort.signal, onProgress: (progress) => {
      if (progress.stage === "inference" && progress.percent !== undefined) { percentages.push(progress.percent); abort.abort(); }
    } })).rejects.toThrow("CANCELED");
    expect(percentages.length).toBeGreaterThan(0);
    expect((await readdir(tmpdir())).filter((name) => name.startsWith("clarune-ai-")).sort()).toEqual(before);
  }, 60_000);
  it("verifies and decodes general 2/3/4x and anime 4x with transparent input", async () => {
    const base = process.env.CLARUNE_REAL_AI_REPORTDIR || tmpdir();
    await mkdir(base, { recursive: true });
    const directory = await mkdtemp(join(base, "clarune-ai-validation-"));
    configureUpscaleRuntime(join(directory, "upscale-runtime.json"));
    expect((await selectUpscaleRuntime(process.env.CLARUNE_REAL_AI_RUNTIME!)).ready).toBe(true);
    expect((await getUpscaleStatus()).ready).toBe(true);
    const width = 96, height = 64;
    const raw = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      raw[offset] = x * 255 / (width - 1); raw[offset + 1] = y * 255 / (height - 1);
      raw[offset + 2] = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 220 : 30;
      raw[offset + 3] = x < 8 || x >= width - 8 || y < 8 || y >= height - 8 ? 0 : x < width / 2 ? 128 : 255;
    }
    const source = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
    await writeFile(join(directory, "source.png"), source);
    const entries: object[] = [];
    const jobs: UpscaleOptions[] = [2, 3, 4].map((scale) => ({ scale: scale as 2 | 3 | 4, model: "realesrgan-x4plus", tileSize: 128 }));
    jobs.push({ scale: 4, model: "realesrgan-x4plus-anime", tileSize: 128 });
    for (const upscale of jobs) {
      const started = Date.now();
      const result = await processImage({ bytes: source, options: { format: "png", quality: 100, upscale } });
      expect([result.width, result.height]).toEqual([width * upscale.scale, height * upscale.scale]);
      const filename = `${upscale.model}-${upscale.scale}x.png`;
      await writeNewFile(join(directory, filename), result.bytes);
      const decoded = await sharp(await readFile(join(directory, filename))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(decoded.info.channels).toBe(4);
      expect(decoded.data[3]).toBe(0);
      const at = (x: number, y: number) => decoded.data[(y * result.width + x) * 4 + 3];
      expect(at(Math.round(result.width * 0.75), Math.round(result.height * 0.5))).toBe(255);
      expect(at(Math.round(result.width * 0.25), Math.round(result.height * 0.5))).toBeGreaterThan(120);
      expect(at(Math.round(result.width * 0.25), Math.round(result.height * 0.5))).toBeLessThan(135);
      const interpolation = await sharp(source).resize(result.width, result.height).ensureAlpha().raw().toBuffer();
      const differentBytes = decoded.data.reduce((count, value, index) => count + Number(value !== interpolation[index]), 0);
      expect(differentBytes).toBeGreaterThan(100);
      entries.push({ filename, scale: upscale.scale, model: upscale.model, width: result.width, height: result.height, size: result.size, durationMs: Date.now() - started, fullDecode: true, transparentCorners: true, opaqueCenter: true, semiTransparentRegion: true, differentFromInterpolationBytes: differentBytes });
    }
    expect((await readdir(directory)).some((name) => name.endsWith(".clarune-partial"))).toBe(false);
    await writeFile(join(directory, "report.json"), JSON.stringify({ passed: true, runtimeExternal: true, directory, entries }, null, 2));
    console.log(`AI_VALIDATION_REPORT=${join(directory, "report.json")}`);
  }, 180_000);
});
