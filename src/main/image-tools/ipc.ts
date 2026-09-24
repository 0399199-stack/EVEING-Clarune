import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { extname, join } from "node:path";
import { rm, stat } from "node:fs/promises";
import sharp from "sharp";
import { IMAGE_TOOL_CHANNELS, UPSCALE_MODELS, type BatchJob, type EnhancementJob, type EnhancementProgress, type ImageFormat, type ImageJob, type PdfJob, type UpscaleOptions } from "../../shared/image-tools";
import { bounded, createPdf, errorResult, ImageToolError, processImage, writeNewFile } from "./processor";
import { runBatch, suggestedFilename, validateBatch } from "./batch";
import { getSystemFonts } from "./fonts";
import { OutputRegistry } from "./output-registry";
import { configureUpscaleRuntime, getUpscaleStatus, selectUpscaleRuntime, upscaleImage, upscaleLargeImage } from "../upscale/runtime";
import { configureRealHatRuntime, stopRealHatProbes } from "../upscale/realhat-runtime";
import { largeInputAllowed, publishLargeUpscale, type LargeUpscaleFile } from "../upscale/large-file";

export function trustedFrame(event: IpcMainInvokeEvent, window: BrowserWindow | null): boolean {
  return !!window && !window.isDestroyed() && BrowserWindow.fromWebContents(event.sender) === window && event.senderFrame !== null && event.senderFrame === event.sender.mainFrame;
}

export interface ImageToolsLifecycle { requestOutputStop: () => Promise<void> | null }

function runtimeModel(value: unknown): UpscaleOptions["model"] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !UPSCALE_MODELS.includes(value as UpscaleOptions["model"])) throw new ImageToolError("INVALID_OPTIONS");
  return value as UpscaleOptions["model"];
}

export function registerImageTools(getWindow: () => BrowserWindow | null, outputs = new OutputRegistry(), runtimeCandidates: string[] = [], realHat?: { worker: string; candidates: string[] }, requireLicense: () => Promise<void> = async () => { throw new ImageToolError("LICENSE_REQUIRED"); }): ImageToolsLifecycle {
  configureUpscaleRuntime(join(app.getPath("userData"), app.isPackaged ? "upscale-runtime-installed.json" : "upscale-runtime.json"), runtimeCandidates);
  if (realHat) configureRealHatRuntime(join(app.getPath("userData"), app.isPackaged ? "realhat-runtime-installed.json" : "realhat-runtime.json"), realHat.worker, realHat.candidates);
  let activeBatch: { id: string; owner: BrowserWindow; canceled: boolean; selecting: boolean; finished: Promise<void>; finish: () => void } | undefined;
  let activeEnhancement: { id: string; owner: BrowserWindow; abort: AbortController; finished: Promise<void>; finish: () => void } | undefined;
  let largeResult: (LargeUpscaleFile & { id: string; owner: BrowserWindow }) | undefined;
  let selectingRuntime = false;
  let stopping = false;
  const exports = new Set<{ phase: "encoding" | "selecting" | "writing"; canceled: boolean; finished: Promise<void>; finish: () => void }>();
  const beginExport = () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const task = { phase: "encoding" as "encoding" | "selecting" | "writing", canceled: false, finished, finish };
    exports.add(task);
    return task;
  };
  const check = (event: IpcMainInvokeEvent) => {
    const window = getWindow();
    if (!trustedFrame(event, window)) throw new ImageToolError("UNTRUSTED_SENDER");
    if (stopping) throw new ImageToolError("CANCELED");
    return window!;
  };
  ipcMain.handle(IMAGE_TOOL_CHANNELS.process, async (event, job: ImageJob) => {
    try {
      check(event);
      // Editing previews stay responsive and never start inference. AI runs only
      // after the user explicitly starts a single or batch export.
      const preview = job?.options && typeof job.options === "object" ? { ...job, options: { ...job.options, upscale: undefined } } : job;
      return { ok: true, value: await bounded(() => processImage(preview)) };
    }
    catch (error) { return errorResult(error); }
  });
  ipcMain.handle(IMAGE_TOOL_CHANNELS.upscaleStatus, async (event, model: unknown) => {
    try { check(event); return { ok: true, value: await getUpscaleStatus(runtimeModel(model)) }; }
    catch (error) { return errorResult(error); }
  });
  ipcMain.handle(IMAGE_TOOL_CHANNELS.enhance, async (event, job: EnhancementJob) => {
    let task: typeof activeEnhancement;
    let pendingLarge: LargeUpscaleFile | undefined;
    try {
      const owner = check(event);
      if (activeEnhancement || activeBatch || exports.size || selectingRuntime) throw new ImageToolError("BUSY");
      if (!job || typeof job !== "object" || typeof job.id !== "string" || !job.id || job.id.length > 128 || !job.upscale) throw new ImageToolError("INVALID_OPTIONS");
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => { finish = resolve; });
      task = { id: job.id, owner, abort: new AbortController(), finished, finish };
      activeEnhancement = task;
      await requireLicense();
      if (task.abort.signal.aborted || !trustedFrame(event, getWindow())) return { ok: false, error: "CANCELED", canceled: true };
      const abort = task.abort;
      const progress = (value: Omit<EnhancementProgress, "id">) => {
        if (abort.signal.aborted) return;
        if (!trustedFrame(event, getWindow())) { abort.abort(); return; }
        try { event.senderFrame!.send(IMAGE_TOOL_CHANNELS.enhancementProgress, { id: job.id, ...value }); }
        catch { abort.abort(); }
      };
      progress({ stage: "preparing" });
      if (!(job.bytes instanceof Uint8Array) || job.bytes.length < 1 || job.bytes.length > 64 * 1024 * 1024) throw new ImageToolError("INPUT_TOO_LARGE");
      const source = Buffer.from(job.bytes);
      const metadata = await sharp(source, { failOn: "error", limitInputPixels: 40_000_000 }).metadata().catch(() => { throw new ImageToolError("INVALID_IMAGE"); });
      if (!["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height) throw new ImageToolError("INVALID_IMAGE");
      const swapped = (metadata.orientation ?? 1) >= 5;
      const width = swapped ? metadata.height : metadata.width;
      const height = swapped ? metadata.width : metadata.height;
      const large = width * height > 2_500_000 || width > 4096 || height > 4096;
      if (large && !largeInputAllowed(width, height, job.upscale.model)) throw new ImageToolError("UPSCALE_INPUT_TOO_LARGE");
      const value = large
        ? await bounded(async () => {
          pendingLarge = await upscaleLargeImage(source, job.upscale, { signal: abort.signal, onProgress: progress });
          return { large: true as const, id: job.id, preview: pendingLarge.preview, width: pendingLarge.width, height: pendingLarge.height, size: pendingLarge.size };
        })
        : await bounded(() => processImage({ bytes: job.bytes, options: { format: "png", quality: 100, upscale: job.upscale } }, (bytes, w, h, options) => upscaleImage(bytes, w, h, options, { signal: abort.signal, onProgress: progress })));
      await requireLicense();
      if (abort.signal.aborted || !trustedFrame(event, getWindow())) return { ok: false, error: "CANCELED", canceled: true };
      if (largeResult) await rm(largeResult.directory, { recursive: true, force: true }).catch(() => undefined);
      largeResult = pendingLarge ? { ...pendingLarge, id: job.id, owner } : undefined;
      pendingLarge = undefined;
      return { ok: true, value };
    } catch (error) {
      if (task?.abort.signal.aborted || (error instanceof ImageToolError && error.message === "CANCELED")) return { ok: false, error: "CANCELED", canceled: true };
      return errorResult(error);
    } finally {
      if (pendingLarge) await rm(pendingLarge.directory, { recursive: true, force: true }).catch(() => undefined);
      if (task) { if (activeEnhancement === task) activeEnhancement = undefined; task.finish(); }
    }
  });
  ipcMain.handle(IMAGE_TOOL_CHANNELS.saveLargeEnhancement, async (event, id: unknown, format: unknown, quality: unknown, suggestedName: unknown) => {
    let task: ReturnType<typeof beginExport> | undefined;
    try {
      const owner = check(event);
      const result = largeResult;
      if (!result || result.owner !== owner || typeof id !== "string" || result.id !== id) throw new ImageToolError("OUTPUT_NOT_FOUND");
      if (!["png", "jpeg", "webp"].includes(String(format)) || typeof quality !== "number" || !Number.isFinite(quality) || quality < 1 || quality > 100 || typeof suggestedName !== "string") throw new ImageToolError("INVALID_OPTIONS");
      if (activeEnhancement || selectingRuntime) throw new ImageToolError("BUSY");
      task = beginExport();
      await requireLicense();
      if (task.canceled || !trustedFrame(event, getWindow())) return { ok: false, error: "CANCELED", canceled: true };
      const extension = format === "jpeg" ? "jpg" : format as string;
      task.phase = "selecting";
      const choice = await dialog.showSaveDialog(owner, { title: "EVEING Clarune", defaultPath: suggestedFilename(suggestedName, extension), filters: [{ name: String(format).toUpperCase(), extensions: format === "jpeg" ? ["jpg", "jpeg"] : [extension] }], properties: ["createDirectory", "showOverwriteConfirmation"] });
      if (task.canceled || !trustedFrame(event, getWindow()) || choice.canceled || !choice.filePath) return { ok: false, error: "CANCELED", canceled: true };
      const suffix = extname(choice.filePath).toLowerCase();
      const path = suffix === `.${extension}` || (format === "jpeg" && suffix === ".jpeg") ? choice.filePath : `${choice.filePath}.${extension}`;
      task.phase = "writing";
      await requireLicense();
      if (task.canceled || !trustedFrame(event, getWindow())) return { ok: false, error: "CANCELED", canceled: true };
      const size = await publishLargeUpscale(result.path, path, format as ImageFormat, quality);
      await outputs.remember([path]);
      return { ok: true, value: { path, size, width: result.width, height: result.height } };
    } catch (error) { return errorResult(error); }
    finally { if (task) { exports.delete(task); task.finish(); } }
  });
  ipcMain.handle(IMAGE_TOOL_CHANNELS.discardLargeEnhancement, async (event, id: unknown) => {
    try {
      const owner = check(event);
      if (!largeResult || largeResult.owner !== owner || largeResult.id !== id || exports.size) return { ok: true, value: false };
      const stale = largeResult;
      largeResult = undefined;
      await rm(stale.directory, { recursive: true, force: true });
      return { ok: true, value: true };
    } catch (error) { return errorResult(error); }
  });
  ipcMain.handle(IMAGE_TOOL_CHANNELS.cancelEnhancement, async (event, id: unknown) => {
    try {
      const owner = check(event);
      if (typeof id !== "string" || !id || id.length > 128) throw new ImageToolError("INVALID_OPTIONS");
      if (!activeEnhancement || activeEnhancement.owner !== owner || activeEnhancement.id !== id) return { ok: true, value: false };
      activeEnhancement.abort.abort();
      return { ok: true, value: true };
    } catch (error) { return errorResult(error); }
  });
  ipcMain.handle(IMAGE_TOOL_CHANNELS.selectUpscaleRuntime, async (event, model: unknown) => {
    let claimed = false;
    try {
      const owner = check(event);
      const selectedModel = runtimeModel(model);
      if (activeBatch || activeEnhancement || exports.size || selectingRuntime) throw new ImageToolError("BUSY");
      selectingRuntime = true; claimed = true;
      const choice = await dialog.showOpenDialog(owner, { title: `EVEING Clarune · ${selectedModel === "real-hat-x4" ? "Real-HAT" : "Real-ESRGAN"} local runtime`, properties: ["openDirectory"] });
      if (choice.canceled || !choice.filePaths[0]) return { ok: false, error: "CANCELED", canceled: true };
      if (!trustedFrame(event, getWindow())) throw new ImageToolError("UNTRUSTED_SENDER");
      return { ok: true, value: await selectUpscaleRuntime(choice.filePaths[0], selectedModel) };
    } catch (error) { return errorResult(error); }
    finally { if (claimed) selectingRuntime = false; }
  });
  ipcMain.handle(IMAGE_TOOL_CHANNELS.fonts, async (event) => {
    try { check(event); return { ok: true, value: await getSystemFonts() }; }
    catch (error) { return errorResult(error); }
  });
  ipcMain.handle(IMAGE_TOOL_CHANNELS.openOutput, async (event, path: unknown) => {
    try {
      check(event);
      const saved = await outputs.resolve(path);
      if (!(await stat(saved).catch(() => null))?.isFile()) throw new ImageToolError("OUTPUT_NOT_FOUND");
      shell.showItemInFolder(saved);
      return { ok: true, value: null };
    } catch (error) { return errorResult(error); }
  });
  ipcMain.handle(IMAGE_TOOL_CHANNELS.copyOutputPath, async (event, path: unknown) => {
    try { check(event); clipboard.writeText(await outputs.resolve(path)); return { ok: true, value: null }; }
    catch (error) { return errorResult(error); }
  });
  ipcMain.handle(IMAGE_TOOL_CHANNELS.cancelBatch, async (event, id: unknown) => {
    try {
      const owner = check(event);
      if (typeof id !== "string" || id.length > 128) throw new ImageToolError("INVALID_OPTIONS");
      if (!activeBatch || activeBatch.owner !== owner || activeBatch.id !== id) return { ok: true, value: false };
      activeBatch.canceled = true;
      return { ok: true, value: true };
    } catch (error) { return errorResult(error); }
  });
  ipcMain.handle(IMAGE_TOOL_CHANNELS.batch, async (event, job: BatchJob) => {
    let claimed = false;
    try {
      const owner = check(event);
      if (activeBatch || activeEnhancement || selectingRuntime) throw new ImageToolError("BUSY");
      validateBatch(job);
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => { finish = resolve; });
      const task = { id: job.id, owner, canceled: false, selecting: true, finished, finish };
      activeBatch = task;
      claimed = true;
      await requireLicense();
      if (task.canceled || !trustedFrame(event, getWindow())) return { ok: false, error: "CANCELED", canceled: true };
      const choice = await dialog.showOpenDialog(owner, { title: "EVEING Clarune", properties: ["openDirectory", "createDirectory"] });
      if (choice.canceled || !choice.filePaths[0]) return { ok: false, error: "CANCELED", canceled: true };
      task.selecting = false;
      const canceled = () => task.canceled || !trustedFrame(event, getWindow());
      const value = await runBatch(job, choice.filePaths[0], canceled, (progress) => {
        // Emit only to the trusted initiating main frame, never a broadcast channel.
        if (trustedFrame(event, getWindow())) {
          try { event.senderFrame!.send(IMAGE_TOOL_CHANNELS.batchProgress, progress); }
          catch { task.canceled = true; }
        }
      }, requireLicense);
      await outputs.remember(value.items.flatMap((item) => item.file ? [item.file.path] : []));
      return { ok: true, value };
    } catch (error) { return errorResult(error); }
    finally {
      if (claimed) {
        const completed = activeBatch;
        activeBatch = undefined;
        completed?.finish();
      }
    }
  });
  ipcMain.handle(IMAGE_TOOL_CHANNELS.save, async (event, job: ImageJob, suggestedName: string) => {
    let task: ReturnType<typeof beginExport> | undefined;
    try {
      const window = check(event);
      if (activeEnhancement || selectingRuntime) throw new ImageToolError("BUSY");
      task = beginExport();
      await requireLicense();
      if (task.canceled || !trustedFrame(event, getWindow())) return { ok: false, error: "CANCELED", canceled: true };
      // Validate and encode before opening the native dialog; invalid jobs never prompt to save.
      const result = await bounded(() => processImage({ ...job, previewLayers: false }));
      if (task.canceled || !trustedFrame(event, getWindow())) return { ok: false, error: "CANCELED", canceled: true };
      const extension = result.format === "jpeg" ? "jpg" : result.format;
      task.phase = "selecting";
      const choice = await dialog.showSaveDialog(window, { title: "EVEING Clarune", defaultPath: suggestedFilename(suggestedName, extension), filters: [{ name: result.format.toUpperCase(), extensions: result.format === "jpeg" ? ["jpg", "jpeg"] : [extension] }], properties: ["createDirectory", "showOverwriteConfirmation"] });
      if (task.canceled || !trustedFrame(event, getWindow()) || choice.canceled || !choice.filePath) return { ok: false, error: "CANCELED", canceled: true };
      const suffix = extname(choice.filePath).toLowerCase();
      const path = suffix === `.${extension}` || (result.format === "jpeg" && suffix === ".jpeg") ? choice.filePath : `${choice.filePath}.${extension}`;
      task.phase = "writing";
      await requireLicense();
      if (task.canceled || !trustedFrame(event, getWindow())) return { ok: false, error: "CANCELED", canceled: true };
      await writeNewFile(path, result.bytes);
      await outputs.remember([path]);
      return { ok: true, value: { path, size: result.size, width: result.width, height: result.height } };
    } catch (error) { return errorResult(error); }
    finally { if (task) { exports.delete(task); task.finish(); } }
  });
  ipcMain.handle(IMAGE_TOOL_CHANNELS.pdf, async (event, job: PdfJob, suggestedName: string) => {
    let task: ReturnType<typeof beginExport> | undefined;
    try {
      const window = check(event);
      if (activeEnhancement || selectingRuntime) throw new ImageToolError("BUSY");
      task = beginExport();
      await requireLicense();
      if (task.canceled || !trustedFrame(event, getWindow())) return { ok: false, error: "CANCELED", canceled: true };
      const result = await bounded(() => createPdf(job));
      if (task.canceled || !trustedFrame(event, getWindow())) return { ok: false, error: "CANCELED", canceled: true };
      task.phase = "selecting";
      const choice = await dialog.showSaveDialog(window, { title: "EVEING Clarune", defaultPath: suggestedFilename(suggestedName, "pdf"), filters: [{ name: "PDF", extensions: ["pdf"] }], properties: ["createDirectory", "showOverwriteConfirmation"] });
      if (task.canceled || !trustedFrame(event, getWindow()) || choice.canceled || !choice.filePath) return { ok: false, error: "CANCELED", canceled: true };
      const path = extname(choice.filePath).toLowerCase() === ".pdf" ? choice.filePath : `${choice.filePath}.pdf`;
      task.phase = "writing";
      await requireLicense();
      if (task.canceled || !trustedFrame(event, getWindow())) return { ok: false, error: "CANCELED", canceled: true };
      await writeNewFile(path, result.bytes);
      await outputs.remember([path]);
      return { ok: true, value: { path, size: result.bytes.length, pages: result.pages } };
    } catch (error) { return errorResult(error); }
    finally { if (task) { exports.delete(task); task.finish(); } }
  });
  return {
    requestOutputStop: () => {
      stopping = true;
      const pending: Promise<void>[] = [];
      const probesStopped = stopRealHatProbes();
      if (probesStopped) pending.push(probesStopped);
      if (activeEnhancement) {
        activeEnhancement.abort.abort();
        pending.push(activeEnhancement.finished);
      }
      if (largeResult) {
        const stale = largeResult;
        largeResult = undefined;
        const writing = [...exports].filter((task) => task.phase !== "selecting").map((task) => task.finished);
        pending.push(Promise.all(writing).then(() => rm(stale.directory, { recursive: true, force: true })));
      }
      for (const task of exports) {
        task.canceled = true;
        if (task.phase !== "selecting") pending.push(task.finished);
      }
      if (activeBatch) {
        activeBatch.canceled = true;
        // No file work exists while the modal picker is open. Let closing the owner
        // dismiss it rather than waiting for a dialog which is blocking that close.
        if (!activeBatch.selecting) pending.push(activeBatch.finished);
      }
      return pending.length ? Promise.all(pending).then(() => undefined) : null;
    },
  };
}
