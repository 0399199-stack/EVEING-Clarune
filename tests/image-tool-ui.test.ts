import { describe, expect, it } from "vitest";
import { boundCrop, centeredCrop, cropFromDrag, resizedDimension, optionsForImage, normalizeParameter, localPreviewOptions } from "../src/shared/image-tool-ui";

describe("image tool geometry", () => {
  it("clamps numeric crop edits to the oriented image", () => {
    expect(boundCrop({ left: 990, top: -2, width: 30, height: 999 }, { width: 1000, height: 500 }))
      .toEqual({ left: 990, top: 0, width: 10, height: 500 });
  });
  it("centers a square crop", () => {
    expect(centeredCrop({ width: 1000, height: 600 }, 1)).toEqual({ left: 200, top: 0, width: 600, height: 600 });
  });
  it("supports reverse direction pointer selections", () => {
    expect(cropFromDrag({ x: 800, y: 450 }, { x: 200, y: 50 }, { width: 1000, height: 500 }))
      .toEqual({ left: 200, top: 50, width: 600, height: 400 });
  });
  it("can include the last row and column when dragging to the far edge", () => {
    expect(cropFromDrag({ x: 0, y: 0 }, { x: 1000, y: 500 }, { width: 1000, height: 500 }))
      .toEqual({ left: 0, top: 0, width: 1000, height: 500 });
  });
  it("preserves a preset ratio without going outside the image", () => {
    const crop = cropFromDrag({ x: 900, y: 450 }, { x: 1000, y: 500 }, { width: 1000, height: 500 }, 2);
    expect(crop).toEqual({ left: 900, top: 450, width: 100, height: 50 });
  });
  it("uses the explicit aspect ratio for linked resizing", () => {
    expect(resizedDimension(600, "width", 2, true, { width: 1000, height: 500 })).toEqual({ width: 600, height: 300 });
    expect(resizedDimension(600, "height", 2, false, { width: 1000, height: 500 })).toEqual({ width: 1000, height: 600 });
  });
  it("keeps linked dimensions within the single-side limit", () => {
    expect(resizedDimension(16384, "height", 2, true, { width: 1000, height: 500 })).toEqual({ width: 16384, height: 8192 });
  });
  it("scales batch crops from a fixed reference without selection drift", () => {
    const options = { format: "png" as const, quality: 100, crop: { left: 100, top: 50, width: 600, height: 300 } };
    const reference = { width: 1000, height: 500 };
    expect(optionsForImage(options, reference, { width: 2000, height: 1000 }, true).crop).toEqual({ left: 200, top: 100, width: 1200, height: 600 });
    expect(optionsForImage(options, reference, reference, true).crop).toEqual(options.crop);
  });
  it("uses a bounding box for different batch aspect ratios when locked", () => {
    const options = { format: "jpeg" as const, quality: 80, resize: { width: 800, height: 400, fit: "fill" as const } };
    expect(optionsForImage(options, null, { width: 400, height: 800 }, true).resize?.fit).toBe("inside");
    expect(optionsForImage(options, null, { width: 400, height: 800 }, false).resize?.fit).toBe("fill");
  });
  it.each(["1:1", "4:3", "16:9"])("preserves fixed %s crops across portrait and landscape images", (preset) => {
    const [width, height] = preset.split(":").map(Number);
    const ratio = width / height;
    const reference = { width: 800, height: 600 };
    const options = { format: "png" as const, quality: 100, crop: centeredCrop(reference, ratio) };
    for (const target of [reference, { width: 300, height: 700 }, { width: 1200, height: 400 }]) {
      const crop = optionsForImage(options, reference, target, true, preset).crop!;
      expect(Math.abs(crop.width - crop.height * ratio)).toBeLessThanOrEqual(ratio);
      expect(crop.left + crop.width).toBeLessThanOrEqual(target.width);
      expect(crop.top + crop.height).toBeLessThanOrEqual(target.height);
    }
  });
  it("normalizes numeric draft values before blur without exceeding bounds", () => {
    expect(normalizeParameter(37.45, -180, 180, 0.1)).toBe(37.5);
    expect(normalizeParameter(999, -180, 180, 0.1)).toBe(180);
    expect(normalizeParameter(-999, -180, 180, 0.1)).toBe(-180);
    expect(normalizeParameter(38, 0, 37.5, 1)).toBe(37.5);
  });
  it.each([2, 3, 4] as const)("uses a non-AI layout proxy at %sx final dimensions", (scale) => {
    const options = { format: "png" as const, quality: 100, upscale: { scale, model: "realesrgan-x4plus" as const, tileSize: 256 as const }, radius: 20 };
    const local = localPreviewOptions(options, { width: 800, height: 600 });
    expect(local.upscale).toBeUndefined();
    expect(local.resize).toEqual({ width: 800 * scale, height: 600 * scale, fit: "fill" });
    expect(local.radius).toBe(20);
    expect(options.upscale.scale).toBe(scale);
  });
  it("uses crop dimensions and preserves explicit final resize constraints", () => {
    const options = { format: "png" as const, quality: 100, upscale: { scale: 4 as const, model: "realesrgan-x4plus-anime" as const, tileSize: 128 as const }, crop: { left: 10, top: 20, width: 300, height: 200 } };
    expect(localPreviewOptions(options, { width: 800, height: 600 }).resize).toEqual({ width: 1200, height: 800, fit: "fill" });
    const resize = { width: 500, height: 400, fit: "inside" as const };
    expect(localPreviewOptions({ ...options, resize }, { width: 800, height: 600 }).resize).toEqual(resize);
  });
  it("does not create oversized AI layout proxies, and leaves local recipes untouched", () => {
    const local = { format: "png" as const, quality: 100 };
    const options = { ...local, upscale: { scale: 4 as const, model: "realesrgan-x4plus" as const, tileSize: 512 as const } };
    expect(localPreviewOptions(options, { width: 2000, height: 2000 })).toEqual(local);
    expect(localPreviewOptions(options, { width: 5000, height: 100 })).toEqual(local);
    expect(localPreviewOptions(local, { width: 800, height: 600 })).toEqual(local);
  });
});
