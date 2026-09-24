import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { processImage, validateOptions } from "../src/main/image-tools/processor";
import { configureUpscaleRuntime, getUpscaleStatus, PINNED_RUNTIME, verifyRuntime } from "../src/main/upscale/runtime";
import type { UpscaleOptions } from "../src/shared/image-tools";
import { localPreviewOptions } from "../src/shared/image-tool-ui";

describe("explicit local AI upscale", () => {
  const options = { format: "png" as const, quality: 100, upscale: { scale: 4 as const, model: "realesrgan-x4plus" as const, tileSize: 128 as const } };
  it.each([2, 3, 4] as const)("runs the AI stage once and returns exact %sx output", async (scale) => {
    const source = await sharp({ create: { width: 32, height: 24, channels: 4, background: { r: 200, g: 30, b: 40, alpha: 0.5 } } }).png().toBuffer();
    const runner = vi.fn(async (bytes: Buffer, width: number, height: number, settings: UpscaleOptions) => {
      expect([width, height]).toEqual([32, 24]);
      expect(settings).toEqual({ ...options.upscale, scale });
      return sharp(bytes).resize(width * scale, height * scale).png().toBuffer();
    });
    const result = await processImage({ bytes: source, options: { ...options, upscale: { ...options.upscale, scale } } }, runner);
    expect(runner).toHaveBeenCalledOnce();
    expect([result.width, result.height]).toEqual([32 * scale, 24 * scale]);
    const raw = await sharp(result.bytes).raw().toBuffer();
    expect(raw[3]).toBeGreaterThan(120); expect(raw[3]).toBeLessThan(135);
  });
  it("orients and crops before AI, then applies explicit size, rotation and watermark", async () => {
    const source = await sharp({ create: { width: 32, height: 24, channels: 3, background: "red" } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const mark = await sharp({ create: { width: 8, height: 8, channels: 4, background: "white" } }).png().toBuffer();
    const runner = vi.fn(async (bytes: Buffer, width: number, height: number) => {
      expect([width, height]).toEqual([12, 20]);
      return sharp(bytes).resize(width * 4, height * 4).png().toBuffer();
    });
    const result = await processImage({ bytes: source, options: { ...options, crop: { left: 0, top: 0, width: 12, height: 20 }, resize: { width: 30, height: 50, fit: "fill" }, rotation: 90, watermark: { image: mark, fontSize: 12, imageScale: 0.2, color: "#ffffff", opacity: 1, position: "custom", x: 1, y: 1 } } }, runner);
    expect([result.width, result.height]).toEqual([50, 30]);
    expect(result.watermarkBounds).toEqual({ left: 40, top: 20, width: 10, height: 10 });
  });
  it("matches preview and export geometry for watermark pixels, rotation and rounded corners without preview inference", async () => {
    const source = await sharp({ create: { width: 80, height: 60, channels: 3, background: "red" } }).png().toBuffer();
    const recipe = { ...options, radius: 30, rotation: 90, watermark: { text: "Clarune", fontSize: 32, imageScale: 0.25, color: "#ffffff", opacity: 1, position: "custom" as const, x: 1, y: 0.5 } };
    const runner = vi.fn(async (bytes: Buffer, width: number, height: number, settings: UpscaleOptions) => sharp(bytes).resize(width * settings.scale, height * settings.scale).png().toBuffer());
    const preview = await processImage({ bytes: source, options: localPreviewOptions(recipe, { width: 80, height: 60 }) }, runner);
    expect(runner).not.toHaveBeenCalled();
    const exported = await processImage({ bytes: source, options: recipe }, runner);
    expect(runner).toHaveBeenCalledOnce();
    expect([preview.width, preview.height]).toEqual([exported.width, exported.height]);
    expect(preview.watermarkBounds).toEqual(exported.watermarkBounds);
    const raw = await sharp(preview.bytes).ensureAlpha().raw().toBuffer();
    expect(raw[3]).toBe(0);
  });
  it("rejects malformed models, unsafe intermediate dimensions and mismatched inference output", async () => {
    for (const upscale of [{ ...options.upscale, scale: 8 }, { ...options.upscale, model: "../../arbitrary" }, { ...options.upscale, tileSize: 0 }]) expect(() => validateOptions({ ...options, upscale }, 32, 24)).toThrow("INVALID_OPTIONS");
    expect(() => validateOptions(options, 2000, 1500)).toThrow("UPSCALE_INPUT_TOO_LARGE");
    expect(() => validateOptions(options, 4097, 20)).toThrow("UPSCALE_INPUT_TOO_LARGE");
    expect(() => validateOptions({ ...options, upscale: { ...options.upscale, scale: 2 } }, 2000, 1500)).toThrow("UPSCALE_INPUT_TOO_LARGE");
    expect(() => validateOptions({ ...options, crop: { left: 0, top: 0, width: 1000, height: 1000 } }, 2000, 1500)).not.toThrow();
    const source = await sharp({ create: { width: 32, height: 24, channels: 3, background: "red" } }).png().toBuffer();
    await expect(processImage({ bytes: source, options }, async () => source)).rejects.toThrow("UPSCALE_INVALID_OUTPUT");
  });
  it("fails closed when no runtime is configured or pinned files do not match", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clarune-runtime-test-"));
    try {
      configureUpscaleRuntime(join(directory, "absent.json"));
      expect(await getUpscaleStatus()).toEqual({ ready: false, localOnly: true, reason: "UPSCALE_RUNTIME_NOT_CONFIGURED" });
      await writeFile(join(directory, "realesrgan-ncnn-vulkan.exe"), "tampered executable bytes");
      await expect(verifyRuntime(directory)).rejects.toThrow(process.platform === "win32" ? "UPSCALE_RUNTIME_UNVERIFIED" : "UPSCALE_PLATFORM_UNSUPPORTED");
      await writeFile(join(directory, "configured.json"), JSON.stringify({ directory }));
      configureUpscaleRuntime(join(directory, "configured.json"));
      expect(await getUpscaleStatus()).toEqual({ ready: false, localOnly: true, reason: process.platform === "win32" ? "UPSCALE_RUNTIME_UNVERIFIED" : "UPSCALE_PLATFORM_UNSUPPORTED" });
      const source = await sharp({ create: { width: 16, height: 16, channels: 3, background: "red" } }).png().toBuffer();
      await expect(processImage({ bytes: source, options })).rejects.toThrow(process.platform === "win32" ? "UPSCALE_RUNTIME_UNVERIFIED" : "UPSCALE_PLATFORM_UNSUPPORTED");
      await writeFile(join(directory, "vulkan-1.dll"), "not a trusted system Vulkan loader");
      await expect(verifyRuntime(directory)).rejects.toThrow(process.platform === "win32" ? "UPSCALE_RUNTIME_UNVERIFIED" : "UPSCALE_PLATFORM_UNSUPPORTED");
      expect(Object.keys(PINNED_RUNTIME)).toHaveLength(6);
      expect(Object.values(PINNED_RUNTIME).every((hash) => /^[a-f0-9]{64}$/.test(hash))).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
