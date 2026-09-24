import { describe, expect, it } from "vitest";
import { canvasImagePoint, moveCropBounds, moveWatermarkBounds, resizeCropBounds, snapWatermarkBounds, watermarkMargin, watermarkPosition, type CropCorner } from "../src/shared/image-tool-canvas";
import { cropFromDrag } from "../src/shared/image-tool-ui";
import { zoomAt } from "../src/shared/viewer-geometry";

describe("image tool canvas coordinates", () => {
  const image = { width: 1000, height: 600 };
  it("converts a panned, zoomed pointer to image pixels", () => {
    expect(canvasImagePoint({ x: 160, y: 100 }, { x: -40, y: -20, scale: 2 }, image)).toEqual({ x: 100, y: 60 });
  });
  it("keeps crop selection within the image after zoom and pan", () => {
    const view = { x: -100, y: -50, scale: 2 };
    const start = canvasImagePoint({ x: 100, y: 150 }, view, image);
    const end = canvasImagePoint({ x: 700, y: 550 }, view, image);
    expect(cropFromDrag(start, end, image)).toEqual({ left: 100, top: 100, width: 300, height: 200 });
    expect(canvasImagePoint({ x: -500, y: 3000 }, view, image)).toEqual({ x: 0, y: 600 });
  });
  it("preserves the pixel under the wheel when unclamped", () => {
    const view = { x: -250, y: -200, scale: 1 };
    const anchor = { x: 250, y: 150 };
    const next = zoomAt(view, 2, anchor, image, { width: 500, height: 300 });
    expect(canvasImagePoint(anchor, next, image)).toEqual(canvasImagePoint(anchor, view, image));
  });
  it("clamps a dragged watermark to actual available travel", () => {
    const mark = { left: 100, top: 100, width: 250, height: 80 };
    const moved = moveWatermarkBounds(mark, { x: 900, y: -120 }, image);
    expect(moved).toEqual({ left: 750, top: 0, width: 250, height: 80 });
    expect(watermarkPosition(moved, image)).toEqual({ x: 1, y: 0 });
  });
  it("normalizes XY against the mark size rather than the canvas size", () => {
    expect(watermarkPosition({ left: 375, top: 130, width: 250, height: 80 }, image))
      .toEqual({ x: 0.5, y: 0.25 });
  });
  it("handles watermarks with no travel without NaN or negative coordinates", () => {
    const mark = { left: 20, top: 30, width: 1000, height: 600 };
    expect(moveWatermarkBounds(mark, { x: 100, y: -100 }, image)).toEqual({ ...mark, left: 0, top: 0 });
    expect(watermarkPosition(mark, image)).toEqual({ x: 0, y: 0 });
  });
  it("moves a crop without resizing and clamps all four image boundaries", () => {
    const crop = { left: 100, top: 100, width: 200, height: 100 };
    expect(moveCropBounds(crop, { x: 24.4, y: 18.8 }, image)).toEqual({ ...crop, left: 124, top: 119 });
    expect(moveCropBounds(crop, { x: -500, y: -500 }, image)).toEqual({ ...crop, left: 0, top: 0 });
    expect(moveCropBounds(crop, { x: 2000, y: 2000 }, image)).toEqual({ ...crop, left: 800, top: 500 });
  });
  it.each([
    ["top-left", { x: 50, y: 50 }, { left: 50, top: 50, width: 250, height: 150 }],
    ["top-right", { x: 400, y: 50 }, { left: 100, top: 50, width: 300, height: 150 }],
    ["bottom-left", { x: 50, y: 300 }, { left: 50, top: 100, width: 250, height: 200 }],
    ["bottom-right", { x: 400, y: 300 }, { left: 100, top: 100, width: 300, height: 200 }],
  ] as const)("resizes %s while anchoring the opposite corner", (corner, point, expected) => {
    expect(resizeCropBounds({ left: 100, top: 100, width: 200, height: 100 }, corner, point, image)).toEqual(expected);
  });
  it.each(["top-left", "top-right", "bottom-left", "bottom-right"] as CropCorner[])("clamps %s resizing and retains a fixed ratio", corner => {
    const crop = { left: 100, top: 100, width: 320, height: 180 };
    const result = resizeCropBounds(crop, corner, {
      x: corner.endsWith("left") ? -1000 : 2000,
      y: corner.startsWith("top") ? -1000 : 2000 }, image, 16 / 9);
    expect(result.left).toBeGreaterThanOrEqual(0); expect(result.top).toBeGreaterThanOrEqual(0);
    expect(result.left + result.width).toBeLessThanOrEqual(image.width);
    expect(result.top + result.height).toBeLessThanOrEqual(image.height);
    expect(Math.abs(result.width - result.height * 16 / 9)).toBeLessThanOrEqual(1);
    expect(corner.endsWith("left") ? result.left + result.width : result.left).toBe(corner.endsWith("left") ? 420 : 100);
    expect(corner.startsWith("top") ? result.top + result.height : result.top).toBe(corner.startsWith("top") ? 280 : 100);
  });
  it("does not invert a corner dragged across its anchor", () => {
    expect(resizeCropBounds({ left: 100, top: 100, width: 200, height: 100 }, "top-left", { x: 500, y: 500 }, image))
      .toEqual({ left: 299, top: 199, width: 1, height: 1 });
  });
  it("shrinks ratio-locked corners with a single-axis mouse or keyboard movement", () => {
    const crop = { left: 100, top: 100, width: 320, height: 180 };
    expect(resizeCropBounds(crop, "bottom-right", { x: 404, y: 280 }, image, 16 / 9)).toEqual({ ...crop, width: 304, height: 171 });
    expect(resizeCropBounds(crop, "top-left", { x: 100, y: 109 }, image, 16 / 9)).toEqual({ left: 116, top: 109, width: 304, height: 171 });
  });
  it("snaps watermark edges, center and the inset guide only inside the screen threshold", () => {
    const mark = { left: 1, top: 249, width: 200, height: 100 };
    expect(watermarkMargin(image)).toBe(15);
    expect(snapWatermarkBounds(mark, image, 3)).toEqual({ ...mark, left: 0, top: 250 });
    expect(snapWatermarkBounds({ ...mark, left: 14, top: 499 }, image, 3)).toEqual({ ...mark, left: 15, top: 500 });
    expect(snapWatermarkBounds({ ...mark, left: 785, top: 485 }, image, 3)).toEqual({ ...mark, left: 785, top: 485 });
    expect(snapWatermarkBounds({ ...mark, left: 123, top: 89 }, image, 3)).toEqual({ ...mark, left: 123, top: 89 });
  });
  it("handles full-image watermark snapping and tiny images", () => {
    expect(snapWatermarkBounds({ left: 0, top: 0, ...image }, image, 6)).toEqual({ left: 0, top: 0, ...image });
    expect(watermarkMargin({ width: 1, height: 1 })).toBe(0);
  });
});
