import { bound, boundCrop } from "./image-tool-ui";
import type { CropRect } from "./image-tools";
import type { Point, Size, ViewTransform } from "./viewer-geometry";

/** Convert a viewport-local pointer to oriented image pixels, at any zoom. */
export function canvasImagePoint(point: Point, view: ViewTransform, image: Size): Point {
  return { x: bound((point.x - view.x) / view.scale, 0, image.width),
    y: bound((point.y - view.y) / view.scale, 0, image.height) };
}

export function moveWatermarkBounds(bounds: CropRect, delta: Point, image: Size): CropRect {
  return { ...bounds, left: bound(bounds.left + delta.x, 0, Math.max(0, image.width - bounds.width)),
    top: bound(bounds.top + delta.y, 0, Math.max(0, image.height - bounds.height)) };
}

export function watermarkMargin(image: Size): number {
  return Math.min(Math.round(Math.min(image.width, image.height) * 0.025), Math.floor((Math.min(image.width, image.height) - 1) / 2));
}

export function snapWatermarkBounds(bounds: CropRect, image: Size, threshold: number): CropRect {
  const margin = watermarkMargin(image);
  const snap = (value: number, travel: number) => {
    const targets = [0, margin, travel / 2, travel - margin, travel].filter(target => target >= 0 && target <= travel);
    const nearest = targets.reduce((best, target) => Math.abs(target - value) < Math.abs(best - value) ? target : best, targets[0]);
    return Math.abs(nearest - value) <= threshold ? Math.round(nearest) : value;
  };
  return { ...bounds, left: snap(bounds.left, Math.max(0, image.width - bounds.width)),
    top: snap(bounds.top, Math.max(0, image.height - bounds.height)) };
}

export type CropCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export function moveCropBounds(bounds: CropRect, delta: Point, image: Size): CropRect {
  return boundCrop(moveWatermarkBounds(bounds, delta, image), image);
}

/** Keep the opposite corner anchored; crossing it clamps to a one-pixel selection. */
export function resizeCropBounds(bounds: CropRect, corner: CropCorner, point: Point, image: Size, ratio?: number): CropRect {
  const left = corner.endsWith("left"), top = corner.startsWith("top");
  const anchor = { x: left ? bounds.left + bounds.width : bounds.left,
    y: top ? bounds.top + bounds.height : bounds.top };
  const maxWidth = left ? anchor.x : image.width - anchor.x;
  const maxHeight = top ? anchor.y : image.height - anchor.y;
  let width = bound((point.x - anchor.x) * (left ? -1 : 1), 1, maxWidth);
  let height = bound((point.y - anchor.y) * (top ? -1 : 1), 1, maxHeight);
  if (ratio && Number.isFinite(ratio) && ratio > 0) {
    const fromWidth = Math.abs(width - bounds.width) >= Math.abs(height - bounds.height) * ratio;
    width = Math.min(fromWidth ? width : height * ratio, maxWidth, maxHeight * ratio);
    height = width / ratio;
  }
  width = Math.max(1, Math.round(width)); height = Math.max(1, Math.round(height));
  return boundCrop({ left: left ? anchor.x - width : anchor.x,
    top: top ? anchor.y - height : anchor.y, width, height }, image);
}

/** XY is a fraction of available travel, not a fraction of the image size. */
export function watermarkPosition(bounds: CropRect, image: Size): Point {
  const width = Math.max(0, image.width - bounds.width);
  const height = Math.max(0, image.height - bounds.height);
  return { x: width ? bound(bounds.left / width, 0, 1) : 0,
    y: height ? bound(bounds.top / height, 0, 1) : 0 };
}
