import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import type { UpscaleOptions, UpscaleStatus } from "../../shared/image-tools";
import { ImageToolError } from "../image-tools/errors";
import { checkUpscaleCanceled, executeUpscale, type UpscaleExecution } from "./native-process";
import { executeRealHat } from "./realhat-process";
import { getRealHatRuntime, getRealHatStatus, selectRealHatRuntime } from "./realhat-runtime";
import { createLargeUpscaleFile, type LargeUpscaleFile } from "./large-file";

// Fixed, hash-verified runtime; release candidates bundle the same tested files.
export const PINNED_RUNTIME = {
  "realesrgan-ncnn-vulkan.exe": "07e49f7cbb4ede01ae4dd4c399d3a7e5846e3d2085c3128eff881e55cb7b1a0c",
  "vcomp140.dll": "8f72ef2e483465444b2059fc6744d6cb22cd8d8a27f6fa56befd2a42dcd0f78b",
  "models/realesrgan-x4plus.bin": "713ee713b0353afaa27976f0563a64a5043bd70b9bd8936c2e26e25ebcdbcddf",
  "models/realesrgan-x4plus.param": "35330ececcea33b6c397a72548e788d5d53becee4734c50b7fada36e89f10a86",
  "models/realesrgan-x4plus-anime.bin": "fe01c269cfd10cdef8e018ab66ebe750cf79c7af4d1f9c16c737e1295229bacc",
  "models/realesrgan-x4plus-anime.param": "2b8fb6e0ae4d2d85704ca08c119a2f5ea40add4f2ecd512eb7f4cd44b6127ed4",
} as const;
const DEBUG_DLL_HASH = "34980f5a28002967d4f2659b10a417b1b9a242e240195947c89195083d146c53";
const VERSION = "Real-ESRGAN ncnn Vulkan · local";
let registryPath: string | undefined;
let runtimeRoot: string | undefined;
let runtimeSource: "selected" | "detected" | undefined;
let loaded: Promise<void> = Promise.resolve();

export function configureUpscaleRuntime(path: string, candidates: string[] = []): void {
  registryPath = path;
  runtimeRoot = undefined;
  runtimeSource = undefined;
  loaded = readFile(path).then((bytes) => {
    if (bytes.length > 16_384) return;
    const entry: unknown = JSON.parse(bytes.toString("utf8"));
    if (entry && typeof entry === "object" && "directory" in entry && typeof entry.directory === "string" && isAbsolute(entry.directory)) { runtimeRoot = entry.directory; runtimeSource = "selected"; }
  }).catch(async (error: NodeJS.ErrnoException) => {
    // A damaged or unavailable explicit choice must not silently select another engine.
    if (error.code !== "ENOENT") return;
    for (const directory of candidates) {
      try { await verifyRuntime(directory); runtimeRoot = directory; runtimeSource = "detected"; return; }
      catch { /* Only these exact app-derived local candidates are considered. */ }
    }
  });
}

/** Revalidate at every launch. Renderer strings never select a command/model path. */
export async function verifyRuntime(directory: string): Promise<void> {
  if (process.platform !== "win32") throw new ImageToolError("UPSCALE_PLATFORM_UNSUPPORTED");
  if (!isAbsolute(directory) || !(await lstat(directory).catch(() => null))?.isDirectory()) throw new ImageToolError("UPSCALE_RUNTIME_NOT_FOUND");
  try {
    const files = await readdir(directory, { withFileTypes: true });
    for (const file of files.filter((file) => /\.dll$/i.test(file.name))) {
      const name = file.name.toLowerCase();
      if (!["vcomp140.dll", "vcomp140d.dll"].includes(name) || !file.isFile()) throw new ImageToolError("UPSCALE_RUNTIME_UNVERIFIED");
      if (name === "vcomp140d.dll" && createHash("sha256").update(await readFile(join(directory, file.name))).digest("hex") !== DEBUG_DLL_HASH) throw new ImageToolError("UPSCALE_RUNTIME_UNVERIFIED");
    }
    for (const [relative, hash] of Object.entries(PINNED_RUNTIME)) {
      const path = join(directory, relative);
      const file = await lstat(path);
      if (!file.isFile() || file.size > 100 * 1024 * 1024 || createHash("sha256").update(await readFile(path)).digest("hex") !== hash) throw new ImageToolError("UPSCALE_RUNTIME_UNVERIFIED");
    }
  } catch (error) {
    if (error instanceof ImageToolError) throw error;
    throw new ImageToolError("UPSCALE_RUNTIME_UNVERIFIED");
  }
}

export async function getUpscaleStatus(model?: UpscaleOptions["model"]): Promise<UpscaleStatus> {
  if (model === "real-hat-x4") return getRealHatStatus();
  await loaded;
  if (!runtimeRoot) return { ready: false, localOnly: true, reason: "UPSCALE_RUNTIME_NOT_CONFIGURED" };
  try { await verifyRuntime(runtimeRoot); return { ready: true, localOnly: true, runtimeVersion: VERSION, source: runtimeSource }; }
  catch (error) { return { ready: false, localOnly: true, reason: error instanceof ImageToolError ? error.message : "UPSCALE_RUNTIME_UNVERIFIED" }; }
}

export async function selectUpscaleRuntime(directory: string, model?: UpscaleOptions["model"]): Promise<UpscaleStatus> {
  if (model === "real-hat-x4") return selectRealHatRuntime(directory);
  await loaded;
  await verifyRuntime(directory);
  if (!registryPath) throw new ImageToolError("UPSCALE_RUNTIME_NOT_CONFIGURED");
  await mkdir(dirname(registryPath), { recursive: true });
  const temporary = `${registryPath}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ directory: resolve(directory), localOnly: true }), { mode: 0o600 });
    await rename(temporary, registryPath);
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new ImageToolError("UPSCALE_RUNTIME_SAVE_FAILED");
  }
  runtimeRoot = resolve(directory);
  runtimeSource = "selected";
  return { ready: true, localOnly: true, runtimeVersion: VERSION, source: runtimeSource };
}

let active = false;
export async function upscaleLargeImage(input: Buffer, options: UpscaleOptions, execution: UpscaleExecution = {}): Promise<LargeUpscaleFile> {
  checkUpscaleCanceled(execution.signal);
  await loaded;
  if (options.model === "real-hat-x4") throw new ImageToolError("UPSCALE_INPUT_TOO_LARGE");
  if (!runtimeRoot) throw new ImageToolError("UPSCALE_RUNTIME_NOT_CONFIGURED");
  if (active) throw new ImageToolError("BUSY");
  active = true;
  try {
    await verifyRuntime(runtimeRoot);
    return await createLargeUpscaleFile(input, options, runtimeRoot, execution);
  } finally { active = false; }
}

export async function upscaleImage(input: Buffer, width: number, height: number, options: UpscaleOptions, execution: UpscaleExecution = {}): Promise<Buffer> {
  checkUpscaleCanceled(execution.signal);
  await loaded;
  if (options.model !== "real-hat-x4" && !runtimeRoot) throw new ImageToolError("UPSCALE_RUNTIME_NOT_CONFIGURED");
  if (active) throw new ImageToolError("BUSY");
  active = true;
  let temporary: string | undefined;
  try {
    const directory = runtimeRoot;
    const realHat = options.model === "real-hat-x4" ? await getRealHatRuntime() : undefined;
    if (!realHat) await verifyRuntime(directory!);
    checkUpscaleCanceled(execution.signal);
    // The model runs at 4x even for 2x/3x output. Bound that real intermediate,
    // not only the final resized result, before spawning a GPU process.
    if (width * height * 16 > 40_000_000 || width * 4 > 16_384 || height * 4 > 16_384) throw new ImageToolError("UPSCALE_INPUT_TOO_LARGE");
    temporary = await mkdtemp(join(tmpdir(), "clarune-ai-"));
    const source = join(temporary, "input.png"), target = join(temporary, "output.png");
    await writeFile(source, input, { flag: "wx" });
    checkUpscaleCanceled(execution.signal);
    execution.onProgress?.({ stage: "inference" });
    if (realHat) await executeRealHat(realHat, source, target, options.tileSize, execution);
    else await executeUpscale(directory!, source, target, options, execution);
    checkUpscaleCanceled(execution.signal);
    execution.onProgress?.({ stage: "finishing" });
    const file = await lstat(target).catch(() => null);
    if (!file?.isFile() || file.size < 1 || file.size > 192 * 1024 * 1024) throw new ImageToolError("UPSCALE_INVALID_OUTPUT");
    const bytes = await readFile(target);
    try {
      const image = sharp(bytes, { failOn: "error", limitInputPixels: 40_000_000 });
      const metadata = await image.metadata();
      if (metadata.format !== "png" || metadata.width !== width * 4 || metadata.height !== height * 4 || (metadata.pages ?? 1) !== 1) throw new Error("Invalid inference dimensions");
      // Full decode proves the native output is complete before entering the
      // normal post-processing/atomic publishing pipeline.
      await image.clone().raw().toBuffer();
      const output = options.scale === 4 ? bytes : await image.resize(width * options.scale, height * options.scale, { kernel: "lanczos3" }).png().toBuffer();
      checkUpscaleCanceled(execution.signal);
      return output;
    } catch (error) {
      checkUpscaleCanceled(execution.signal);
      throw error instanceof ImageToolError ? error : new ImageToolError("UPSCALE_INVALID_OUTPUT");
    }
  } finally {
    // mkdtemp is the sole source of this path; never remove the selected runtime.
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    active = false;
  }
}
