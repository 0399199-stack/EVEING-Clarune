import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdtemp, open, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import sharp from "sharp";
import type { ImageFormat, UpscaleOptions } from "../../shared/image-tools";
import { ImageToolError } from "../image-tools/errors";
import { checkUpscaleCanceled, executeUpscale, type UpscaleExecution } from "./native-process";

const MAX_INPUT_PIXELS = 16_000_000;
const MAX_INPUT_SIDE = 8192;
const MAX_NATIVE_PIXELS = MAX_INPUT_PIXELS * 16;
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

export interface LargeUpscaleFile { directory: string; path: string; preview: Buffer; width: number; height: number; size: number }
type NativeRunner = typeof executeUpscale;

export function largeInputAllowed(width: number, height: number, model: UpscaleOptions["model"]): boolean {
  return model !== "real-hat-x4" && Number.isInteger(width) && Number.isInteger(height) &&
    width > 0 && height > 0 && width <= MAX_INPUT_SIDE && height <= MAX_INPUT_SIDE && width * height <= MAX_INPUT_PIXELS;
}

/** Keep the full AI result on disk; only the display-sized preview crosses IPC. */
export async function createLargeUpscaleFile(bytes: Buffer, options: UpscaleOptions, runtime: string,
  execution: UpscaleExecution = {}, runNative: NativeRunner = executeUpscale): Promise<LargeUpscaleFile> {
  if (bytes.length < 1 || bytes.length > 64 * 1024 * 1024 || ![2, 3, 4].includes(options.scale) ||
    ![128, 256, 512].includes(options.tileSize) || !["realesrgan-x4plus", "realesrgan-x4plus-anime"].includes(options.model)) {
    throw new ImageToolError("INVALID_OPTIONS");
  }
  const decoder = sharp(bytes, { failOn: "error", limitInputPixels: 40_000_000 });
  const metadata = await decoder.metadata().catch(() => { throw new ImageToolError("INVALID_IMAGE"); });
  if (!["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height) throw new ImageToolError("INVALID_IMAGE");
  const swapped = (metadata.orientation ?? 1) >= 5;
  const width = swapped ? metadata.height : metadata.width;
  const height = swapped ? metadata.width : metadata.height;
  if (!largeInputAllowed(width, height, options.model)) throw new ImageToolError("UPSCALE_INPUT_TOO_LARGE");
  checkUpscaleCanceled(execution.signal);
  const directory = await mkdtemp(join(tmpdir(), "clarune-large-ai-"));
  let complete = false;
  try {
    const input = join(directory, "input.png");
    const native = join(directory, "native.png");
    const resized = join(directory, "result.png");
    await decoder.autoOrient().png().toFile(input);
    checkUpscaleCanceled(execution.signal);
    await runNative(runtime, input, native, options, { ...execution, timeoutMs: 40 * 60_000 });
    checkUpscaleCanceled(execution.signal);
    execution.onProgress?.({ stage: "finishing" });
    const file = await lstat(native).catch(() => null);
    if (!file?.isFile() || file.size < 1 || file.size > MAX_FILE_BYTES) throw new ImageToolError("UPSCALE_INVALID_OUTPUT");
    const output = sharp(native, { failOn: "error", limitInputPixels: MAX_NATIVE_PIXELS });
    const info = await output.metadata();
    if (info.format !== "png" || info.width !== width * 4 || info.height !== height * 4 || (info.pages ?? 1) !== 1) throw new ImageToolError("UPSCALE_INVALID_OUTPUT");
    const target = options.scale === 4 ? native : resized;
    if (options.scale !== 4) {
      await output.resize(width * options.scale, height * options.scale, { kernel: "lanczos3" }).png({ compressionLevel: 3 }).toFile(target);
      checkUpscaleCanceled(execution.signal);
    }
    const targetFile = await lstat(target);
    if (!targetFile.isFile() || targetFile.size < 1 || targetFile.size > MAX_FILE_BYTES) throw new ImageToolError("UPSCALE_INVALID_OUTPUT");
    const preview = await sharp(target, { failOn: "error", limitInputPixels: MAX_NATIVE_PIXELS })
      .resize({ width: 4096, height: 4096, fit: "inside", withoutEnlargement: true }).png().toBuffer();
    checkUpscaleCanceled(execution.signal);
    complete = true;
    return { directory, path: target, preview, width: width * options.scale, height: height * options.scale, size: targetFile.size };
  } catch (error) {
    if (execution.signal?.aborted) throw new ImageToolError("CANCELED");
    throw error instanceof ImageToolError ? error : new ImageToolError("UPSCALE_INVALID_OUTPUT");
  } finally {
    if (!complete) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function publishLargeUpscale(source: string, destination: string, format: ImageFormat, quality: number): Promise<number> {
  if (!["png", "jpeg", "webp"].includes(format) || !Number.isFinite(quality) || quality < 1 || quality > 100) throw new ImageToolError("INVALID_OPTIONS");
  const input = sharp(source, { failOn: "error", limitInputPixels: MAX_NATIVE_PIXELS });
  const metadata = await input.metadata();
  if (!metadata.width || !metadata.height || metadata.format !== "png" || (metadata.pages ?? 1) !== 1) throw new ImageToolError("UPSCALE_INVALID_OUTPUT");
  if (format === "webp" && (metadata.width > 16383 || metadata.height > 16383)) throw new ImageToolError("OUTPUT_TOO_LARGE");
  try { if (await lstat(destination)) throw new ImageToolError("FILE_EXISTS"); }
  catch (error) { if (error instanceof ImageToolError) throw error; if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ImageToolError("WRITE_FAILED"); }
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.clarune-partial`);
  try {
    if (format === "png" && quality === 100) await copyFile(source, temporary, constants.COPYFILE_EXCL);
    else if (format === "jpeg") await input.flatten({ background: "#ffffff" }).jpeg({ quality: Math.round(quality) }).toFile(temporary);
    else if (format === "webp") await input.webp({ quality: Math.round(quality) }).toFile(temporary);
    else await input.png({ compressionLevel: 9, palette: true, quality: Math.round(quality) }).toFile(temporary);
    const file = await lstat(temporary);
    if (!file.isFile() || file.size < 1 || file.size > MAX_FILE_BYTES) throw new ImageToolError("OUTPUT_TOO_LARGE");
    const handle = await open(temporary, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    try { await link(temporary, destination); }
    catch (error) { throw new ImageToolError((error as NodeJS.ErrnoException).code === "EEXIST" ? "FILE_EXISTS" : "WRITE_FAILED"); }
    return file.size;
  } catch (error) {
    throw error instanceof ImageToolError ? error : new ImageToolError("WRITE_FAILED");
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
