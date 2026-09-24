import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { bounded, checkDimensions, createPdf, ImageToolError, LIMITS, processImage, writeNewFile } from "../src/main/image-tools/processor";
import type { ImageEditOptions } from "../src/shared/image-tools";
import { getSystemFonts } from "../src/main/image-tools/fonts";

async function fixture(width = 64, height = 48) {
  const bytes = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = y < height / 2 ? (x < width / 2 ? [240, 20, 30] : [20, 230, 30]) : (x < width / 2 ? [20, 30, 240] : [240, 220, 20]);
    bytes.set(color, (y * width + x) * 3);
  }
  return sharp(bytes, { raw: { width, height, channels: 3 } }).png().toBuffer();
}
const run = async (options: Partial<ImageEditOptions> = {}, bytes?: Uint8Array) => processImage({ bytes: bytes ?? await fixture(), options: { format: "png", quality: 100, ...options } });
async function pixel(bytes: Uint8Array, x: number, y: number) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)];
}

describe("local image processing", () => {
  it("decodes all supported formats and preserves lossless PNG pixels", async () => {
    for (const format of ["png", "jpeg", "webp"] as const) {
      const source = await sharp(await fixture()).toFormat(format).toBuffer();
      const result = await run({}, source);
      expect([result.width, result.height, result.format]).toEqual([64, 48, "png"]);
      expect(result.size).toBe(result.bytes.length);
    }
    expect(await pixel((await run()).bytes, 2, 2)).toEqual([240, 20, 30, 255]);
  });
  it("auto-orients EXIF before cropping in displayed original coordinates", async () => {
    const oriented = await sharp(await fixture()).withMetadata({ orientation: 6 }).jpeg({ quality: 100 }).toBuffer();
    const result = await run({ crop: { left: 0, top: 0, width: 20, height: 20 } }, oriented);
    expect([result.width, result.height]).toEqual([20, 20]);
    const p = await pixel(result.bytes, 5, 5);
    expect(p[2]).toBeGreaterThan(200); expect(p[0]).toBeLessThan(50);
  });
  it("applies crop then resize then rotation with exact geometry", async () => {
    const result = await run({ crop: { left: 0, top: 0, width: 32, height: 24 }, resize: { width: 80, height: 60, fit: "fill" }, rotation: 90 });
    expect([result.width, result.height]).toEqual([60, 80]);
    expect(await pixel(result.bytes, 20, 20)).toEqual([240, 20, 30, 255]);
    const fitted = await run({ resize: { width: 100, height: 100, fit: "inside" } });
    expect([fitted.width, fitted.height]).toEqual([100, 75]);
  });
  it("rotates before horizontal and vertical flips", async () => {
    expect(await pixel((await run({ flipHorizontal: true })).bytes, 2, 2)).toEqual([20, 230, 30, 255]);
    expect(await pixel((await run({ flipVertical: true })).bytes, 2, 2)).toEqual([20, 30, 240, 255]);
    expect(await pixel((await run({ rotation: 90, flipHorizontal: true })).bytes, 2, 2)).toEqual([240, 20, 30, 255]);
  });
  it("keeps alpha on PNG/WebP corners and fills JPEG corners with white", async () => {
    for (const format of ["png", "webp"] as const) {
      const result = await run({ radius: 15, format });
      expect((await pixel(result.bytes, 0, 0))[3]).toBe(0);
      expect((await pixel(result.bytes, 32, 24))[3]).toBe(255);
    }
    const jpeg = await run({ radius: 15, format: "jpeg" });
    expect((await pixel(jpeg.bytes, 0, 0)).slice(0, 3).every((c) => c >= 245)).toBe(true);
    expect((await pixel((await run({ rotation: 45 })).bytes, 0, 0))[3]).toBe(0);
  });
  it("applies text/image watermarks with escaped XML, opacity and position", async () => {
    const options = { text: '澄像 <tag> & "EVEING"', color: "#ffffff", fontSize: 14, imageScale: 0.25, opacity: 1, position: "center" as const };
    const original = await run();
    const marked = await run({ watermark: options });
    expect(Buffer.compare(Buffer.from(original.bytes), Buffer.from(marked.bytes))).not.toBe(0);
    expect((await run({ watermark: { ...options, opacity: 0 } })).bytes).toEqual(original.bytes);
    const stamp = await sharp({ create: { width: 20, height: 20, channels: 4, background: "white" } }).png().toBuffer();
    const imageMarked = await run({ watermark: { ...options, text: undefined, image: stamp, position: "bottom-right" } });
    expect(await pixel(imageMarked.bytes, 58, 42)).toEqual([255, 255, 255, 255]);
    expect(await pixel(imageMarked.bytes, 2, 2)).toEqual([240, 20, 30, 255]);
  });
  it("changes actual output bytes and size with the compression slider", async () => {
    const data = Buffer.alloc(160 * 120 * 3);
    for (let i = 0; i < data.length; i++) data[i] = (i * 79 + Math.floor(i / 37) * 97) % 256;
    const source = await sharp(data, { raw: { width: 160, height: 120, channels: 3 } }).png().toBuffer();
    for (const format of ["png", "jpeg", "webp"] as const) {
      const low = await run({ format, quality: 20 }, source);
      const high = await run({ format, quality: 100 }, source);
      expect(low.size).toBeLessThan(high.size);
    }
  });
  it("enumerates installed fonts and uses the selected family for actual text pixels", async () => {
    const fonts = await getSystemFonts();
    expect(fonts.length).toBeGreaterThan(0);
    expect(new Set(fonts).size).toBe(fonts.length);
    const families = process.platform === "win32" ? ["Arial", "Courier New"] : ["serif", "monospace"];
    for (const font of families) expect(fonts).toContain(font);
    const source = await fixture(640, 300);
    const watermark = { text: "Wide W narrow i 123", color: "#ffffff", fontSize: 40, imageScale: 0.25, opacity: 1, position: "center" as const };
    const a = await run({ watermark: { ...watermark, fontFamily: families[0] } }, source);
    const b = await run({ watermark: { ...watermark, fontFamily: families[1] } }, source);
    expect(a.bytes).not.toEqual(b.bytes);
    expect(a.watermarkBounds?.width).not.toEqual(b.watermarkBounds?.width);
    await expect(run({ watermark: { ...watermark, fontFamily: "Uninstalled-Clarune-Font-123456" } })).rejects.toThrow("INVALID_OPTIONS");
  }, 20_000);
  it("places watermark bounds at normalized custom coordinates including both edges", async () => {
    const stamp = await sharp({ create: { width: 20, height: 20, channels: 4, background: "white" } }).png().toBuffer();
    const watermark = { image: stamp, color: "#ffffff", fontSize: 14, imageScale: 0.25, opacity: 1, position: "custom" as const, x: 1, y: 1 };
    const marked = await run({ watermark });
    expect(marked.watermarkBounds).toEqual({ left: 48, top: 32, width: 16, height: 16 });
    expect(await pixel(marked.bytes, 63, 47)).toEqual([255, 255, 255, 255]);
    expect((await run({ watermark: { ...watermark, x: 0, y: 0 } })).watermarkBounds).toEqual({ left: 0, top: 0, width: 16, height: 16 });
    expect((await run({ watermark: { ...watermark, x: 0.5, y: 0.25 } })).watermarkBounds).toEqual({ left: 24, top: 8, width: 16, height: 16 });
    await expect(run({ watermark: { ...watermark, x: 1.1 } })).rejects.toThrow("INVALID_OPTIONS");
    await expect(run({ watermark: { ...watermark, y: undefined } })).rejects.toThrow("INVALID_OPTIONS");
  });
  it("returns exact movable watermark preview layers without changing exported pixels", async () => {
    const bytes = await fixture();
    const stamp = await sharp({ create: { width: 20, height: 20, channels: 4, background: "white" } }).png().toBuffer();
    const options: ImageEditOptions = { format: "png", quality: 100, flipHorizontal: true, radius: 12, watermark: { image: stamp, color: "#ffffff", fontSize: 14, imageScale: 0.25, opacity: 0.5, position: "center" } };
    const preview = await processImage({ bytes, options, previewLayers: true });
    const saved = await processImage({ bytes, options });
    expect(saved.watermarkLayers).toBeUndefined();
    expect(preview.bytes).toEqual(saved.bytes);
    const layers = preview.watermarkLayers!, bounds = preview.watermarkBounds!;
    expect(layers.base).toEqual((await processImage({ bytes, options: { ...options, watermark: undefined } })).bytes);
    expect((await sharp(layers.overlay).metadata()).width).toBe(bounds.width);
    expect((await pixel(layers.overlay, 2, 2))[3]).toBeCloseTo(128, -1);
    const combined = await sharp(layers.base).composite([{ input: Buffer.from(layers.overlay), left: bounds.left, top: bounds.top }]).raw().toBuffer();
    const flattened = await sharp(preview.bytes).raw().toBuffer();
    expect(combined.every((value, index) => Math.abs(value - flattened[index]) <= 1)).toBe(true);
    expect((await pixel(layers.base, 0, 0))[3]).toBe(0);
  });
  it("rejects invalid, SVG, animated and excessive input/options", async () => {
    const source = await fixture();
    for (const invalid of [new Uint8Array(), Buffer.from("not image"), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')]) await expect(run({}, invalid)).rejects.toThrow("INVALID_IMAGE");
    const animated = await sharp([source, await sharp(source).negate().png().toBuffer()], { join: { animated: true } }).webp().toBuffer();
    expect((await sharp(animated).metadata()).pages).toBe(2);
    await expect(run({}, animated)).rejects.toThrow("INVALID_IMAGE");
    await expect(run({ quality: NaN })).rejects.toThrow("INVALID_OPTIONS");
    await expect(run({ crop: { left: 63, top: 0, width: 2, height: 2 } })).rejects.toThrow("INVALID_OPTIONS");
    await expect(run({ resize: { width: 10000, height: 10000, fit: "fill" } })).rejects.toThrow("OUTPUT_TOO_LARGE");
    expect(() => checkDimensions(LIMITS.dimension + 1, 1)).toThrow("OUTPUT_TOO_LARGE");
    await expect(run({}, new Uint8Array(LIMITS.bytes + 1))).rejects.toThrow("INPUT_TOO_LARGE");
  });
});

describe("PDF and file safety", () => {
  it("keeps image order and uses image-proportional or A4 fitted pages", async () => {
    const images = [{ name: "wide.png", bytes: await fixture(320, 200) }, { name: "portrait.png", bytes: await fixture(80, 120) }];
    const result = await createPdf({ images, pageSize: "image", quality: 90 });
    const pdf = await PDFDocument.load(result.bytes);
    expect(pdf.getPages().map((p) => [p.getWidth(), p.getHeight()])).toEqual([[240, 150], [60, 90]]);
    expect(result.pages).toBe(2);
    const a4 = await PDFDocument.load((await createPdf({ images, pageSize: "a4", quality: 80 })).bytes);
    expect(a4.getPages().map((p) => [p.getWidth(), p.getHeight()])).toEqual([[595.28, 841.89], [595.28, 841.89]]);
    const landscape = await PDFDocument.load((await createPdf({ images, pageSize: "a4-landscape", quality: 80 })).bytes);
    expect(landscape.getPages().map((p) => [p.getWidth(), p.getHeight()])).toEqual([[841.89, 595.28], [841.89, 595.28]]);
    await expect(createPdf({ images: [], pageSize: "a4", quality: 80 })).rejects.toThrow("INVALID_OPTIONS");
  });
  it("writes real output once and never overwrites an existing file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clarune-image-test-"));
    try {
      const path = join(directory, "export.png"), result = await run();
      await writeNewFile(path, result.bytes);
      expect(await readFile(path)).toEqual(Buffer.from(result.bytes));
      await expect(writeNewFile(path, Buffer.from("replacement"))).rejects.toThrow("FILE_EXISTS");
      expect(await readFile(path)).toEqual(Buffer.from(result.bytes));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("publishes one complete file under concurrent no-overwrite writes and removes temporary files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clarune-atomic-test-"));
    try {
      const path = join(directory, "output.png");
      const a = Buffer.alloc(4 * 1024 * 1024, 17), b = Buffer.alloc(4 * 1024 * 1024, 83);
      const results = await Promise.allSettled([writeNewFile(path, a), writeNewFile(path, b)]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
      expect(failed.reason.message).toBe("FILE_EXISTS");
      const output = await readFile(path);
      expect(output.equals(a) || output.equals(b)).toBe(true);
      expect(await readdir(directory)).toEqual(["output.png"]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("bounds active operations and rejects overflow", async () => {
    let active = 0, peak = 0;
    const releases: Array<() => void> = [];
    const work = () => bounded(async () => { active++; peak = Math.max(peak, active); await new Promise<void>((resolve) => releases.push(resolve)); active--; return true; });
    const tasks = Array.from({ length: 6 }, work);
    await expect(work()).rejects.toBeInstanceOf(ImageToolError);
    while (releases.length) { releases.shift()!(); await new Promise((resolve) => setTimeout(resolve, 0)); }
    await Promise.all(tasks);
    expect(peak).toBe(2);
  });
});
