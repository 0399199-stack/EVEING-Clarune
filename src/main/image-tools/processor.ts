import sharp, { type OutputInfo, type OverlayOptions, type Sharp } from "sharp";
import { PDFDocument } from "pdf-lib";
import { link, lstat, open, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ImageJob, ImageEditOptions, PdfJob, ProcessedImage, WatermarkOptions, ToolResult } from "../../shared/image-tools";
import { UPSCALE_MODELS } from "../../shared/image-tools";
import { isInstalledFont } from "./fonts";
import { ImageToolError } from "./errors";
import { upscaleImage } from "../upscale/runtime";
export { ImageToolError } from "./errors";

export const LIMITS = { bytes: 64 * 1024 * 1024, pixels: 40_000_000, dimension: 16_384, pdfImages: 60, pdfBytes: 128 * 1024 * 1024 } as const;
const fail = (code: string): never => { throw new ImageToolError(code); };
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function number(value: unknown, min: number, max: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail("INVALID_OPTIONS");
  return value as number;
}

export function checkDimensions(width: number, height: number, code = "OUTPUT_TOO_LARGE"): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > LIMITS.dimension || height > LIMITS.dimension || width * height > LIMITS.pixels) fail(code);
}

function inputBuffer(bytes: unknown): Buffer {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) fail("INVALID_IMAGE");
  if ((bytes as Uint8Array).length > LIMITS.bytes) fail("INPUT_TOO_LARGE");
  return Buffer.from(bytes as Uint8Array);
}

async function inspect(bytes: unknown) {
  const buffer = inputBuffer(bytes);
  try {
    const metadata = await sharp(buffer, { failOn: "error", limitInputPixels: LIMITS.pixels }).metadata();
    if (!["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height) fail("INVALID_IMAGE");
    checkDimensions(metadata.width, metadata.height, "INPUT_TOO_LARGE");
    const swapped = (metadata.orientation ?? 1) >= 5;
    return { buffer, width: swapped ? metadata.height : metadata.width, height: swapped ? metadata.width : metadata.height };
  } catch (error) {
    if (error instanceof ImageToolError) throw error;
    if (error instanceof Error && /pixel limit/i.test(error.message)) fail("INPUT_TOO_LARGE");
    return fail("INVALID_IMAGE");
  }
}

export function validateOptions(value: unknown, width: number, height: number): ImageEditOptions {
  if (!record(value) || !["png", "jpeg", "webp"].includes(String(value.format))) fail("INVALID_OPTIONS");
  const o = value as unknown as ImageEditOptions;
  number(o.quality, 1, 100);
  if (o.upscale !== undefined) {
    if (!record(o.upscale) || ![2, 3, 4].includes(o.upscale.scale) || !UPSCALE_MODELS.includes(o.upscale.model) || ![128, 256, 512].includes(o.upscale.tileSize)) fail("INVALID_OPTIONS");
    const widthForAI = o.crop?.width ?? width, heightForAI = o.crop?.height ?? height;
    if (widthForAI * heightForAI * 16 > LIMITS.pixels || widthForAI * 4 > LIMITS.dimension || heightForAI * 4 > LIMITS.dimension) fail("UPSCALE_INPUT_TOO_LARGE");
  }
  if (o.crop !== undefined) {
    if (!record(o.crop)) fail("INVALID_OPTIONS");
    number(o.crop.left, 0, width - 1, true); number(o.crop.top, 0, height - 1, true);
    number(o.crop.width, 1, width, true); number(o.crop.height, 1, height, true);
    if (o.crop.left + o.crop.width > width || o.crop.top + o.crop.height > height) fail("INVALID_OPTIONS");
  }
  if (o.resize !== undefined) {
    if (!record(o.resize) || !["inside", "fill"].includes(o.resize.fit)) fail("INVALID_OPTIONS");
    number(o.resize.width, 1, LIMITS.dimension, true); number(o.resize.height, 1, LIMITS.dimension, true);
    checkDimensions(o.resize.width, o.resize.height);
  }
  if (o.rotation !== undefined) number(o.rotation, -360, 360);
  for (const flip of [o.flipHorizontal, o.flipVertical]) if (flip !== undefined && typeof flip !== "boolean") fail("INVALID_OPTIONS");
  if (o.radius !== undefined) number(o.radius, 0, LIMITS.dimension);
  if (o.watermark !== undefined) {
    const w = o.watermark;
    if (!record(w) || !["top-left", "top-right", "center", "bottom-left", "bottom-right", "custom"].includes(w.position)) fail("INVALID_OPTIONS");
    if (typeof w.color !== "string" || !/^#[\da-f]{6}$/i.test(w.color)) fail("INVALID_OPTIONS");
    number(w.opacity, 0, 1); number(w.fontSize, 1, 2048); number(w.imageScale, 0.01, 1);
    if (w.text !== undefined && (typeof w.text !== "string" || w.text.length > 200)) fail("INVALID_OPTIONS");
    if (w.fontFamily !== undefined && (typeof w.fontFamily !== "string" || !w.fontFamily.trim() || w.fontFamily.length > 200 || /[\x00-\x1f]/.test(w.fontFamily))) fail("INVALID_OPTIONS");
    if (w.x !== undefined) number(w.x, 0, 1);
    if (w.y !== undefined) number(w.y, 0, 1);
    if (w.position === "custom") { number(w.x, 0, 1); number(w.y, 0, 1); }
    if (w.image !== undefined) inputBuffer(w.image);
    if (!w.image && !w.text?.trim()) fail("INVALID_OPTIONS");
  }
  return o;
}

function rawImage(data: Buffer, info: OutputInfo) {
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels }, limitInputPixels: LIMITS.pixels });
}

const escapeXml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));

async function watermarkLayer(w: WatermarkOptions, width: number, height: number) {
  const margin = Math.min(Math.round(Math.min(width, height) * 0.025), Math.floor((Math.min(width, height) - 1) / 2));
  const availableWidth = Math.max(1, width - margin * 2), availableHeight = Math.max(1, height - margin * 2);
  let layer: Buffer;
  if (w.image) {
    const source = await inspect(w.image);
    layer = await sharp(source.buffer).autoOrient().resize({ width: Math.min(availableWidth, Math.max(1, Math.round(width * w.imageScale))), height: availableHeight, fit: "inside" }).ensureAlpha().png().toBuffer();
  } else {
    const text = w.text!.trim();
    if (w.fontFamily && !(await isInstalledFont(w.fontFamily))) fail("INVALID_OPTIONS");
    const family = w.fontFamily || "Microsoft YaHei, Noto Sans CJK SC, sans-serif";
    const renderText = (fontSize: number) => sharp({ text: { text: `<span font_family="${escapeXml(family)}" size="${Math.max(1, Math.round(fontSize * 1024))}" foreground="${w.color}">${escapeXml(text)}</span>`, rgba: true, dpi: 72 } });
    // Measure actual glyphs at a bounded size, then fit without guessed character widths.
    const measured = await renderText(64).png().toBuffer({ resolveWithObject: true });
    const fontSize = Math.max(0.1, Math.min(w.fontSize, 64 * availableWidth / measured.info.width, 64 * availableHeight / measured.info.height));
    layer = await renderText(fontSize).png().toBuffer();
    layer = await sharp(layer).resize({ width: availableWidth, height: availableHeight, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  }
  const metadata = await sharp(layer).metadata();
  const lw = metadata.width!, lh = metadata.height!;
  if (w.opacity < 1) {
    layer = await sharp(layer).ensureAlpha().composite([{ input: { create: { width: lw, height: lh, channels: 4, background: { r: 255, g: 255, b: 255, alpha: w.opacity } } }, blend: "dest-in" }]).png().toBuffer();
  }
  const left = w.position === "custom" ? Math.round((width - lw) * w.x!) : w.position === "center" ? Math.round((width - lw) / 2) : w.position.endsWith("right") ? width - lw - margin : margin;
  const top = w.position === "custom" ? Math.round((height - lh) * w.y!) : w.position === "center" ? Math.round((height - lh) / 2) : w.position.startsWith("bottom") ? height - lh - margin : margin;
  return { input: layer, left, top, width: lw, height: lh };
}

/** Only receives bytes, never renderer-supplied file paths. Every intermediate respects the pixel budget. */
export async function processImage(job: ImageJob, runUpscale = upscaleImage): Promise<ProcessedImage> {
  if (!record(job)) fail("INVALID_OPTIONS");
  const source = await inspect(job.bytes);
  const o = validateOptions(job.options, source.width, source.height);
  // Separate orientation and rotation stages keep crop coordinates in oriented-original pixels.
  let pixels = await sharp(source.buffer, { failOn: "error", limitInputPixels: LIMITS.pixels }).autoOrient().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let geometry = rawImage(pixels.data, pixels.info);
  if (o.crop) geometry = geometry.extract(o.crop);
  if (o.upscale) {
    const prepared = await geometry.png().toBuffer({ resolveWithObject: true });
    const upscaled = await runUpscale(prepared.data, prepared.info.width, prepared.info.height, o.upscale);
    pixels = await sharp(upscaled, { failOn: "error", limitInputPixels: LIMITS.pixels }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (pixels.info.width !== prepared.info.width * o.upscale.scale || pixels.info.height !== prepared.info.height * o.upscale.scale) fail("UPSCALE_INVALID_OUTPUT");
    checkDimensions(pixels.info.width, pixels.info.height);
    geometry = rawImage(pixels.data, pixels.info);
  }
  if (o.resize) geometry = geometry.resize({ ...o.resize, withoutEnlargement: false });
  pixels = await geometry.raw().toBuffer({ resolveWithObject: true });
  if (o.rotation) {
    const radians = o.rotation * Math.PI / 180;
    checkDimensions(Math.max(1, Math.ceil(Math.abs(pixels.info.width * Math.cos(radians)) + Math.abs(pixels.info.height * Math.sin(radians)) - 1e-7)), Math.max(1, Math.ceil(Math.abs(pixels.info.height * Math.cos(radians)) + Math.abs(pixels.info.width * Math.sin(radians)) - 1e-7)));
    pixels = await rawImage(pixels.data, pixels.info).rotate(o.rotation, { background: transparent }).raw().toBuffer({ resolveWithObject: true });
  }
  const { width, height } = pixels.info;
  checkDimensions(width, height);
  let output = rawImage(pixels.data, pixels.info);
  if (o.flipHorizontal) output = output.flop();
  if (o.flipVertical) output = output.flip();
  // Resolve flips before applying the watermark: text is never mirrored.
  if (o.flipHorizontal || o.flipVertical) {
    pixels = await output.raw().toBuffer({ resolveWithObject: true });
    output = rawImage(pixels.data, pixels.info);
  }
  const overlays: OverlayOptions[] = [];
  let watermarkBounds: ProcessedImage["watermarkBounds"];
  let watermarkLayers: ProcessedImage["watermarkLayers"];
  let watermarkOverlay: Buffer | undefined;
  if (o.watermark) {
    const layer = await watermarkLayer(o.watermark, width, height);
    watermarkBounds = { left: layer.left, top: layer.top, width: layer.width, height: layer.height };
    overlays.push({ input: layer.input, left: layer.left, top: layer.top });
    if (job.previewLayers === true) watermarkOverlay = layer.input;
  }
  if (o.radius) {
    const radius = Math.min(o.radius, width / 2, height / 2);
    overlays.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${radius}" fill="white"/></svg>`), blend: "dest-in" });
  }
  const encode = async (image: Sharp) => {
    const quality = Math.round(o.quality);
    // Flatten after composites so rounded JPEG corners become white rather than black.
    if (o.format === "jpeg") {
      const composited = await image.raw().toBuffer({ resolveWithObject: true });
      return rawImage(composited.data, composited.info).flatten({ background: "#ffffff" }).jpeg({ quality, mozjpeg: true }).toBuffer();
    }
    if (o.format === "webp") return image.webp({ quality }).toBuffer();
    return image.png(o.quality >= 100 ? { compressionLevel: 9 } : { compressionLevel: 9, palette: true, quality, effort: 7 }).toBuffer();
  };
  if (watermarkOverlay) {
    let base = rawImage(pixels.data, pixels.info);
    const corners = overlays.filter((overlay) => overlay.blend === "dest-in");
    if (corners.length) base = base.composite(corners);
    watermarkLayers = { base: await encode(base), overlay: watermarkOverlay };
  }
  if (overlays.length) output = output.composite(overlays);
  const encoded = await encode(output);
  if (encoded.length > LIMITS.bytes) fail("OUTPUT_TOO_LARGE");
  return { bytes: encoded, width, height, format: o.format, size: encoded.length, ...(watermarkBounds ? { watermarkBounds } : {}), ...(watermarkLayers ? { watermarkLayers } : {}) };
}

export async function createPdf(job: PdfJob): Promise<{ bytes: Uint8Array; pages: number }> {
  if (!record(job) || !Array.isArray(job.images) || !["image", "a4", "a4-landscape"].includes(job.pageSize)) fail("INVALID_OPTIONS");
  number(job.quality, 1, 100);
  if (!job.images.length || job.images.length > LIMITS.pdfImages) fail("INVALID_OPTIONS");
  let total = 0;
  for (const item of job.images) {
    if (!record(item) || typeof item.name !== "string" || item.name.length > 1000) fail("INVALID_OPTIONS");
    total += inputBuffer(item.bytes).length;
    if (total > LIMITS.pdfBytes) fail("INPUT_TOO_LARGE");
  }
  const pdf = await PDFDocument.create();
  pdf.setCreator("EVEING Clarune"); pdf.setProducer("EVEING Clarune");
  for (const item of job.images) {
    const image = await processImage({ bytes: item.bytes, options: { format: "jpeg", quality: job.quality } });
    const embedded = await pdf.embedJpg(image.bytes);
    const pageSize: [number, number] = job.pageSize === "a4" ? [595.28, 841.89] : job.pageSize === "a4-landscape" ? [841.89, 595.28] : [image.width * 0.75, image.height * 0.75];
    const page = pdf.addPage(pageSize);
    const margin = job.pageSize === "image" ? 0 : 24;
    const scale = Math.min((pageSize[0] - margin * 2) / image.width, (pageSize[1] - margin * 2) / image.height);
    page.drawImage(embedded, { x: (pageSize[0] - image.width * scale) / 2, y: (pageSize[1] - image.height * scale) / 2, width: image.width * scale, height: image.height * scale });
  }
  const bytes = await pdf.save();
  if (bytes.length > LIMITS.pdfBytes) fail("OUTPUT_TOO_LARGE");
  return { bytes, pages: job.images.length };
}

export async function writeNewFile(path: string, bytes: Uint8Array): Promise<void> {
  // Publish only a completely flushed file. link is exclusive even if another app
  // creates the destination after the preflight; rename can overwrite on Windows.
  try { await lstat(path); return fail("FILE_EXISTS"); }
  catch (error) {
    if (error instanceof ImageToolError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail("WRITE_FAILED");
  }
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.clarune-partial`);
  let file;
  try {
    file = await open(temporary, "wx");
    await file.writeFile(bytes);
    await file.sync();
    await file.close(); file = undefined;
    try { await link(temporary, path); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return fail(code === "EEXIST" ? "FILE_EXISTS" : ["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes(code ?? "") ? "OUTPUT_FILESYSTEM_UNSUPPORTED" : "WRITE_FAILED");
    }
  } catch (error) {
    if (error instanceof ImageToolError) throw error;
    return fail("WRITE_FAILED");
  } finally {
    await file?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

export function errorResult<T>(error: unknown): ToolResult<T> {
  return { ok: false, error: error instanceof ImageToolError ? error.message : "PROCESSING_FAILED" };
}

let active = 0;
const waiting: Array<() => void> = [];
export async function bounded<T>(work: () => Promise<T>): Promise<T> {
  if (active >= 2) {
    if (waiting.length >= 4) fail("BUSY");
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else active++;
  try { return await work(); }
  finally { const next = waiting.shift(); if (next) next(); else active--; }
}
