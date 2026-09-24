import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { UpscaleOptions } from "../src/shared/image-tools";
import type { UpscaleExecution } from "../src/main/upscale/native-process";
import { IMAGE_TOOL_CHANNELS } from "../src/shared/image-tools";
import { ImageToolError } from "../src/main/image-tools/errors";

const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(), fromWebContents: vi.fn(), showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), upscale: vi.fn(), largeUpscale: vi.fn(), status: vi.fn(), selectRuntime: vi.fn(), stopProbes: vi.fn() }));
vi.mock("electron", () => ({
  app: { getPath: () => process.env.TEMP || process.env.TMP || "/tmp" },
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => mocks.handlers.set(channel, handler) },
  dialog: { showOpenDialog: mocks.showOpenDialog, showSaveDialog: mocks.showSaveDialog }, shell: {}, clipboard: {},
}));
vi.mock("../src/main/upscale/runtime", () => ({ configureUpscaleRuntime: vi.fn(), getUpscaleStatus: mocks.status, selectUpscaleRuntime: mocks.selectRuntime, upscaleImage: mocks.upscale, upscaleLargeImage: mocks.largeUpscale }));
vi.mock("../src/main/upscale/realhat-runtime", () => ({ configureRealHatRuntime: vi.fn(), stopRealHatProbes: mocks.stopProbes }));
import { registerImageTools as registerLicensedImageTools } from "../src/main/image-tools/ipc";
const registerImageTools = (getWindow: () => BrowserWindow | null) => registerLicensedImageTools(getWindow, undefined, [], undefined, async () => undefined);

const owner = { isDestroyed: () => false } as BrowserWindow;
const frame = { send: vi.fn() }, event = { sender: { mainFrame: frame }, senderFrame: frame } as unknown as IpcMainInvokeEvent;
const settings = { scale: 4 as const, model: "realesrgan-x4plus" as const, tileSize: 128 as const };
const call = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!(event, ...args);
let source: Buffer;
beforeEach(async () => {
  mocks.fromWebContents.mockReturnValue(owner); mocks.upscale.mockReset(); mocks.largeUpscale.mockReset(); frame.send.mockClear();
  mocks.status.mockReset().mockResolvedValue({ ready: true, localOnly: true }); mocks.selectRuntime.mockReset().mockResolvedValue({ ready: true, localOnly: true });
  mocks.stopProbes.mockReset().mockReturnValue(null);
  mocks.showOpenDialog.mockReset(); mocks.showSaveDialog.mockReset(); registerImageTools(() => owner);
  source = await sharp({ create: { width: 24, height: 16, channels: 4, background: { r: 40, g: 120, b: 220, alpha: 0.5 } } }).png().toBuffer();
});

describe("explicit single-image enhancement IPC", () => {
  it("includes outstanding capability-probe child cleanup in final window shutdown", async () => {
    const lifecycle = registerImageTools(() => owner);
    let close!: () => void, stopped = false;
    mocks.stopProbes.mockReturnValueOnce(new Promise<void>((resolve) => { close = resolve; }));
    const pending = lifecycle.requestOutputStop(); expect(pending).not.toBeNull();
    void pending!.then(() => { stopped = true; }); await Promise.resolve();
    expect(mocks.stopProbes).toHaveBeenCalledOnce(); expect(stopped).toBe(false);
    close(); await pending; expect(stopped).toBe(true); expect(lifecycle.requestOutputStop()).toBeNull();
  });
  it("routes Real-HAT status/selection only by whitelisted model ids and keeps the omitted-model contract", async () => {
    for (const invalid of [null, {}, "C:\\python.exe", "unknown", "real-hat-x4 --unsafe"]) {
      expect(await call(IMAGE_TOOL_CHANNELS.upscaleStatus, invalid)).toEqual({ ok: false, error: "INVALID_OPTIONS" });
      expect(await call(IMAGE_TOOL_CHANNELS.selectUpscaleRuntime, invalid)).toEqual({ ok: false, error: "INVALID_OPTIONS" });
    }
    expect(mocks.showOpenDialog).not.toHaveBeenCalled(); expect(mocks.status).not.toHaveBeenCalled();
    await call(IMAGE_TOOL_CHANNELS.upscaleStatus); expect(mocks.status).toHaveBeenLastCalledWith(undefined);
    await call(IMAGE_TOOL_CHANNELS.upscaleStatus, "real-hat-x4"); expect(mocks.status).toHaveBeenLastCalledWith("real-hat-x4");
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["C:\\chosen"] });
    expect(await call(IMAGE_TOOL_CHANNELS.selectUpscaleRuntime, "real-hat-x4")).toMatchObject({ ok: true });
    expect(mocks.selectRuntime).toHaveBeenLastCalledWith("C:\\chosen", "real-hat-x4");
    expect(mocks.showOpenDialog.mock.lastCall![1].title).toContain("Real-HAT");
  });
  it("accepts Real-HAT in the same protected enhancement pipeline", async () => {
    mocks.upscale.mockImplementation(async (bytes: Buffer, width: number, height: number, options: UpscaleOptions) => {
      expect(options.model).toBe("real-hat-x4");
      return sharp(bytes).resize(width * options.scale, height * options.scale).png().toBuffer();
    });
    expect(await call(IMAGE_TOOL_CHANNELS.enhance, { id: "hat", bytes: source, upscale: { ...settings, model: "real-hat-x4" } })).toMatchObject({ ok: true, value: { width: 96, height: 64 } });
  });
  it("returns real worker output as a lossless PNG in memory without a save dialog", async () => {
    mocks.upscale.mockImplementation(async (bytes: Buffer, width: number, height: number, options: UpscaleOptions, execution: UpscaleExecution) => {
      expect(execution.signal?.aborted).toBe(false);
      execution.onProgress?.({ stage: "inference" }); execution.onProgress?.({ stage: "inference", percent: 25 }); execution.onProgress?.({ stage: "finishing" });
      return sharp(bytes).resize(width * options.scale, height * options.scale).png().toBuffer();
    });
    const result = await call(IMAGE_TOOL_CHANNELS.enhance, { id: "ai-1", bytes: source, upscale: settings }) as { ok: boolean; value: { bytes: Uint8Array; width: number; height: number; format: string } };
    expect(result.ok).toBe(true); expect([result.value.width, result.value.height, result.value.format]).toEqual([96, 64, "png"]);
    expect((await sharp(result.value.bytes).raw().toBuffer()).length).toBe(96 * 64 * 4);
    expect(frame.send.mock.calls).toEqual(["preparing", "inference", "inference", "finishing"].map((stage, index) => [IMAGE_TOOL_CHANNELS.enhancementProgress, { id: "ai-1", stage, ...(index === 2 ? { percent: 25 } : {}) }]));
    expect(mocks.showSaveDialog).not.toHaveBeenCalled(); expect(mocks.showOpenDialog).not.toHaveBeenCalled();
  });
  it("rejects unsafe sources and options before worker launch, while previews never run AI", async () => {
    for (const job of [{ id: "", bytes: source, upscale: settings }, { id: "x", bytes: source, upscale: { ...settings, scale: 20 } }, { id: "x", bytes: source, upscale: { ...settings, model: "../unsafe" } }]) expect(await call(IMAGE_TOOL_CHANNELS.enhance, job)).toEqual({ ok: false, error: "INVALID_OPTIONS" });
    const large = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: "white" } }).png().toBuffer();
    const preview = await sharp(large).resize(300, 225).png().toBuffer();
    mocks.largeUpscale.mockResolvedValue({ directory: "/absent-test-large-output", path: "/absent-test-large-output/result.png", preview, width: 8000, height: 6000, size: 1234 });
    expect(await call(IMAGE_TOOL_CHANNELS.enhance, { id: "large", bytes: large, upscale: settings })).toMatchObject({ ok: true, value: { large: true, id: "large", width: 8000, height: 6000, size: 1234 } });
    expect(mocks.largeUpscale).toHaveBeenCalledOnce();
    const oversized = await sharp({ create: { width: 4001, height: 4000, channels: 3, background: "white" } }).png().toBuffer();
    expect(await call(IMAGE_TOOL_CHANNELS.enhance, { id: "oversized", bytes: oversized, upscale: settings })).toEqual({ ok: false, error: "UPSCALE_INPUT_TOO_LARGE" });
    expect(await call(IMAGE_TOOL_CHANNELS.process, { bytes: source, options: { format: "png", quality: 100, upscale: settings } })).toMatchObject({ ok: true, value: { width: 24, height: 16 } });
    expect(mocks.upscale).not.toHaveBeenCalled();
  });
  it("serializes AI against batch, export and runtime changes and scopes cancellation to its owner/id", async () => {
    let finish!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    mocks.upscale.mockImplementation((_bytes: Buffer, _width: number, _height: number, _options: UpscaleOptions, execution: UpscaleExecution) => new Promise<Buffer>((_resolve, reject) => { finish = () => reject(new ImageToolError("CANCELED")); entered(); expect(execution.signal?.aborted).toBe(false); }));
    const job = { id: "running", bytes: source, upscale: settings };
    const pending = call(IMAGE_TOOL_CHANNELS.enhance, job); await started;
    expect(await call(IMAGE_TOOL_CHANNELS.enhance, job)).toEqual({ ok: false, error: "BUSY" });
    expect(await call(IMAGE_TOOL_CHANNELS.batch, { id: "batch", images: [] })).toEqual({ ok: false, error: "BUSY" });
    expect(await call(IMAGE_TOOL_CHANNELS.save, { bytes: source, options: { format: "png", quality: 100 } }, "result")).toEqual({ ok: false, error: "BUSY" });
    expect(await call(IMAGE_TOOL_CHANNELS.selectUpscaleRuntime)).toEqual({ ok: false, error: "BUSY" });
    expect(await call(IMAGE_TOOL_CHANNELS.cancelEnhancement, "another-id")).toEqual({ ok: true, value: false });
    expect(await mocks.handlers.get(IMAGE_TOOL_CHANNELS.cancelEnhancement)!({ ...event, senderFrame: {} }, job.id)).toEqual({ ok: false, error: "UNTRUSTED_SENDER" });
    expect(await call(IMAGE_TOOL_CHANNELS.cancelEnhancement, job.id)).toEqual({ ok: true, value: true });
    let settled = false; void pending.then(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false);
    finish(); expect(await pending).toEqual({ ok: false, error: "CANCELED", canceled: true });
    expect(await call(IMAGE_TOOL_CHANNELS.cancelEnhancement, job.id)).toEqual({ ok: true, value: false });
  });
  it("window closing aborts AI and waits for its cleanup to finish", async () => {
    const lifecycle = registerImageTools(() => owner);
    let finish!: () => void, entered!: () => void, signal: AbortSignal | undefined;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    mocks.upscale.mockImplementation((_bytes: Buffer, _width: number, _height: number, _options: UpscaleOptions, execution: UpscaleExecution) => new Promise<Buffer>((_resolve, reject) => { signal = execution.signal; finish = () => reject(new ImageToolError("CANCELED")); entered(); }));
    const pending = call(IMAGE_TOOL_CHANNELS.enhance, { id: "close", bytes: source, upscale: settings }); await started;
    let closed = false;
    const stopped = lifecycle.requestOutputStop(); expect(stopped).not.toBeNull(); void stopped!.then(() => { closed = true; });
    await Promise.resolve(); expect(signal?.aborted).toBe(true); expect(closed).toBe(false);
    finish(); await pending; await stopped; expect(closed).toBe(true); expect(lifecycle.requestOutputStop()).toBeNull();
  });
  it.each(["batch", "runtime", "save"] as const)("does not start AI while a %s operation owns a native dialog", async (kind) => {
    let finish!: (value: unknown) => void, opened!: () => void;
    const shown = new Promise<void>((resolve) => { opened = resolve; });
    const dialog = kind === "save" ? mocks.showSaveDialog : mocks.showOpenDialog;
    dialog.mockImplementationOnce(() => { opened(); return new Promise((resolve) => { finish = resolve; }); });
    const pending = kind === "runtime" ? call(IMAGE_TOOL_CHANNELS.selectUpscaleRuntime) : kind === "batch" ? call(IMAGE_TOOL_CHANNELS.batch, { id: "batch", images: [{ id: "one", name: "one.png", bytes: source, options: { format: "png", quality: 100 } }] }) : call(IMAGE_TOOL_CHANNELS.save, { bytes: source, options: { format: "png", quality: 100 } }, "one");
    await shown;
    expect(await call(IMAGE_TOOL_CHANNELS.enhance, { id: "busy", bytes: source, upscale: settings })).toEqual({ ok: false, error: "BUSY" });
    finish({ canceled: true, filePaths: [] }); await pending;
    expect(mocks.upscale).not.toHaveBeenCalled();
  });
});
