import type { CropRect, ImageEditOptions } from "./image-tools";

export interface ImageSize { width: number; height: number }
export interface ImagePoint { x: number; y: number }
export function bound(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
export function boundCrop(crop: CropRect, size: ImageSize): CropRect {
  const left = Math.round(bound(crop.left, 0, size.width - 1));
  const top = Math.round(bound(crop.top, 0, size.height - 1));
  return { left, top, width: Math.round(bound(crop.width, 1, size.width - left)),
    height: Math.round(bound(crop.height, 1, size.height - top)) };
}
export function centeredCrop(size: ImageSize, ratio: number): CropRect {
  const width = Math.min(size.width, size.height * ratio);
  const height = width / ratio;
  return boundCrop({ left: (size.width - width) / 2, top: (size.height - height) / 2, width, height }, size);
}
export function cropFromDrag(start: ImagePoint, end: ImagePoint, size: ImageSize, ratio?: number): CropRect {
  const x = bound(end.x, 0, size.width);
  const y = bound(end.y, 0, size.height);
  let width = Math.abs(x - start.x);
  let height = Math.abs(y - start.y);
  if (ratio) {
    const maxWidth = x >= start.x ? size.width - start.x : start.x;
    const maxHeight = y >= start.y ? size.height - start.y : start.y;
    width = Math.min(Math.max(width, height * ratio), maxWidth, maxHeight * ratio);
    height = width / ratio;
  }
  return boundCrop({ left: x < start.x ? start.x - width : start.x,
    top: y < start.y ? start.y - height : start.y, width, height }, size);
}
export function resizedDimension(value: number, axis: "width" | "height", ratio: number, locked: boolean, current: ImageSize): ImageSize {
  let width = axis === "width" ? bound(value, 1, 16384) : current.width;
  let height = axis === "height" ? bound(value, 1, 16384) : current.height;
  if (locked) {
    if (axis === "width") height = Math.round(width / ratio);
    else width = Math.round(height * ratio);
    const factor = Math.min(1, 16384 / width, 16384 / height);
    width *= factor;
    height *= factor;
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

// The stored crop belongs to one fixed reference image. Selecting another queue
// item must never re-scale that stored rectangle, which would accumulate rounding.
export function optionsForImage(options: ImageEditOptions, reference: ImageSize | null, target: ImageSize, preserveRatio: boolean, cropRatio = "free"): ImageEditOptions {
  let crop = options.crop && reference ? boundCrop({
    left: options.crop.left / reference.width * target.width,
    top: options.crop.top / reference.height * target.height,
    width: options.crop.width / reference.width * target.width,
    height: options.crop.height / reference.height * target.height,
  }, target) : options.crop;
  if (crop && reference && cropRatio !== "free") {
    const ratio = cropRatio === "original" ? target.width / target.height : Number(cropRatio.split(":")[0]) / Number(cropRatio.split(":")[1]);
    if (Number.isFinite(ratio) && ratio > 0) {
      const centerX = crop.left + crop.width / 2;
      const centerY = crop.top + crop.height / 2;
      const width = Math.min(crop.width, crop.height * ratio);
      const height = width / ratio;
      crop = boundCrop({ left: centerX - width / 2, top: centerY - height / 2, width, height }, target);
    }
  }
  return { ...options, crop, resize: options.resize ? { ...options.resize, fit: preserveRatio ? "inside" : "fill" } : undefined };
}

export function normalizeParameter(value: number, min: number, max: number, step = 1) {
  return bound(Number((Math.round(bound(value, min, max) / step) * step).toFixed(2)), min, max);
}

// Editing a preview must never start an AI inference job. Only explicit save
// actions pass the complete recipe to the export pipeline.
export function localPreviewOptions(options: ImageEditOptions, source: ImageSize): ImageEditOptions {
  const { upscale, ...local } = options;
  const width = options.crop?.width ?? source.width;
  const height = options.crop?.height ?? source.height;
  if (upscale && !local.resize && width <= 4096 && height <= 4096 && width * height <= 2_500_000) {
    // An ordinary resize is only a layout proxy, not an AI result. It lets
    // watermark pixels, corner radii and drag coordinates match the export.
    local.resize = { width: width * upscale.scale, height: height * upscale.scale, fit: "fill" };
  }
  return local;
}
