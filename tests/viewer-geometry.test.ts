import { describe, expect, it } from "vitest";
import { clampView, fitImage, sameAspectRatio, zoomAt } from "../src/shared/viewer-geometry";

describe("image viewing geometry", () => {
  const image = { width: 1600, height: 1000 };
  const viewport = { width: 800, height: 600 };
  it("fits the full image with padding and centers it", () => {
    const view = fitImage(image, viewport);
    expect(view.scale).toBeCloseTo(0.47);
    expect(view.x).toBeCloseTo(24);
    expect(view.y).toBeCloseTo(65);
  });
  it("keeps the image coordinate under the cursor fixed when zooming", () => {
    const view = { scale: 1, x: -300, y: -100 };
    const anchor = { x: 300, y: 250 };
    const next = zoomAt(view, 2, anchor, image, viewport);
    expect((anchor.x - next.x) / next.scale).toBe((anchor.x - view.x) / view.scale);
    expect((anchor.y - next.y) / next.scale).toBe((anchor.y - view.y) / view.scale);
  });
  it("clamps panning so a zoomed image cannot be lost outside the canvas", () => {
    expect(clampView({ scale: 1, x: 900, y: -2000 }, image, viewport))
      .toEqual({ scale: 1, x: 0, y: -400 });
  });
  it("keeps small images centered and bounds extreme wheel zoom", () => {
    const next = zoomAt({ scale: 1, x: 0, y: 0 }, 0.00001, { x: 0, y: 0 }, image, viewport);
    expect(next.scale).toBe(0.05);
    expect(next.x).toBe((viewport.width - image.width * next.scale) / 2);
    expect(zoomAt(next, 1000, { x: 400, y: 300 }, image, viewport).scale).toBe(16);
  });
  it("accepts scaled copies but rejects incompatible comparison geometry", () => {
    expect(sameAspectRatio(image, { width: 6400, height: 4000 })).toBe(true);
    expect(sameAspectRatio(image, { width: 1000, height: 1600 })).toBe(false);
  });
});
