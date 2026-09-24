import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { IMAGE_TOOL_CHANNELS } from "../src/shared/image-tools";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  fromWebContents: vi.fn(),
  showSaveDialog: vi.fn(),
  showOpenDialog: vi.fn(),
  showItemInFolder: vi.fn(),
  writeText: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { getPath: () => process.env.TEMP || process.env.TMP || "/tmp" },
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => mocks.handlers.set(channel, handler) },
  dialog: { showSaveDialog: mocks.showSaveDialog, showOpenDialog: mocks.showOpenDialog },
  shell: { showItemInFolder: mocks.showItemInFolder },
  clipboard: { writeText: mocks.writeText },
}));
import { registerImageTools as registerLicensedImageTools, trustedFrame } from "../src/main/image-tools/ipc";
const registerImageTools = (getWindow: () => BrowserWindow | null) => registerLicensedImageTools(getWindow, undefined, [], undefined, async () => undefined);
import { protectOutputClose } from "../src/main/image-tools/window-close";

function closableWindow(onClosed: () => void = () => undefined): BrowserWindow {
  let destroyed = false;
  const listeners: Array<(event: { preventDefault: () => void }) => void> = [];
  return {
    isDestroyed: () => destroyed,
    webContents: { on: vi.fn() },
    on: (_name: string, listener: (event: { preventDefault: () => void }) => void) => { listeners.push(listener); },
    close: () => {
      let prevented = false;
      listeners.forEach((listener) => listener({ preventDefault: () => { prevented = true; } }));
      if (!prevented) { onClosed(); destroyed = true; }
    },
  } as unknown as BrowserWindow;
}

describe("image-tool IPC security", () => {
  const frame = { send: vi.fn() }, sender = { mainFrame: frame };
  const window = { isDestroyed: () => false } as BrowserWindow;
  const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  it("accepts only the current window's main frame", () => {
    mocks.fromWebContents.mockReturnValue(window);
    expect(trustedFrame(event, window)).toBe(true);
    expect(trustedFrame({ ...event, senderFrame: {} } as IpcMainInvokeEvent, window)).toBe(false);
    expect(trustedFrame({ ...event, senderFrame: null }, window)).toBe(false);
    expect(trustedFrame(event, null)).toBe(false);
    mocks.fromWebContents.mockReturnValue(null);
    expect(trustedFrame(event, window)).toBe(false);
  });
  it("rejects an untrusted sender before processing or opening dialogs", async () => {
    registerImageTools(() => window);
    mocks.fromWebContents.mockReturnValue(null);
    for (const channel of Object.values(IMAGE_TOOL_CHANNELS).filter((channel) => channel !== IMAGE_TOOL_CHANNELS.batchProgress && channel !== IMAGE_TOOL_CHANNELS.enhancementProgress)) {
      expect(await mocks.handlers.get(channel)!(event, {}, "anything")).toEqual({ ok: false, error: "UNTRUSTED_SENDER" });
    }
    expect(mocks.showSaveDialog).not.toHaveBeenCalled();
    expect(mocks.showOpenDialog).not.toHaveBeenCalled();
  });
  it("prompts with a sanitized filename and returns cancellation without writing", async () => {
    mocks.fromWebContents.mockReturnValue(window);
    mocks.showSaveDialog.mockResolvedValue({ canceled: true });
    const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: "white" } }).png().toBuffer();
    const result = await mocks.handlers.get(IMAGE_TOOL_CHANNELS.save)!(event, { bytes, options: { format: "png", quality: 100 } }, "../../overwrite.exe");
    expect(result).toEqual({ ok: false, error: "CANCELED", canceled: true });
    const options = mocks.showSaveDialog.mock.lastCall![1];
    expect(options.defaultPath).not.toMatch(/[\\/]/);
    expect(options.defaultPath).toMatch(/\.png$/);
  });
  it("never performs AI inference for editing previews, and validates runtime selection in the main process", async () => {
    registerImageTools(() => window);
    mocks.fromWebContents.mockReturnValue(window);
    const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: "white" } }).png().toBuffer();
    const result = await mocks.handlers.get(IMAGE_TOOL_CHANNELS.process)!(event, { bytes, options: { format: "png", quality: 100, upscale: { scale: 4, model: "realesrgan-x4plus", tileSize: 128 } } }) as { ok: boolean; value: { width: number; height: number } };
    expect(result.ok).toBe(true);
    expect([result.value.width, result.value.height]).toEqual([10, 10]);
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await mocks.handlers.get(IMAGE_TOOL_CHANNELS.selectUpscaleRuntime)!(event, "C:\\arbitrary-executable.exe")).toEqual({ ok: false, error: "INVALID_OPTIONS" });
    expect(await mocks.handlers.get(IMAGE_TOOL_CHANNELS.selectUpscaleRuntime)!(event)).toEqual({ ok: false, error: "CANCELED", canceled: true });
    expect(mocks.showOpenDialog.mock.lastCall![1].properties).toEqual(["openDirectory"]);
  });
  it("picks a directory only once, blocks concurrent batches and supports cancellation scoped to the job", async () => {
    registerImageTools(() => window);
    mocks.fromWebContents.mockReturnValue(window);
    frame.send.mockClear();
    const dir = await mkdtemp(join(tmpdir(), "clarune-ipc-batch-test-"));
    try {
      const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: "white" } }).png().toBuffer();
      const job = { id: "native-batch", images: [{ id: "1", name: "native.png", bytes, options: { format: "png", quality: 100 } }] };
      let resolveDialog!: (value: unknown) => void;
      mocks.showOpenDialog.mockReturnValueOnce(new Promise((resolve) => { resolveDialog = resolve; }));
      const pending = mocks.handlers.get(IMAGE_TOOL_CHANNELS.batch)!(event, job);
      expect(await mocks.handlers.get(IMAGE_TOOL_CHANNELS.batch)!(event, job)).toEqual({ ok: false, error: "BUSY" });
      expect(await mocks.handlers.get(IMAGE_TOOL_CHANNELS.cancelBatch)!(event, "wrong-job")).toEqual({ ok: true, value: false });
      expect(await mocks.handlers.get(IMAGE_TOOL_CHANNELS.cancelBatch)!({ ...event, senderFrame: {} }, job.id)).toEqual({ ok: false, error: "UNTRUSTED_SENDER" });
      expect(await mocks.handlers.get(IMAGE_TOOL_CHANNELS.cancelBatch)!(event, job.id)).toEqual({ ok: true, value: true });
      resolveDialog({ canceled: false, filePaths: [dir] });
      expect(await pending).toEqual({ ok: true, value: { directory: dir, canceled: true, items: [{ id: "1", name: "native.png", status: "canceled" }] } });
      expect(await readdir(dir)).toEqual([]);
      expect(frame.send.mock.lastCall).toEqual([IMAGE_TOOL_CHANNELS.batchProgress, { id: job.id, completed: 1, total: 1, item: { id: "1", name: "native.png", status: "canceled" } }]);
      mocks.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
      expect(await mocks.handlers.get(IMAGE_TOOL_CHANNELS.batch)!(event, job)).toEqual({ ok: false, error: "CANCELED", canceled: true });
      expect(await mocks.handlers.get(IMAGE_TOOL_CHANNELS.cancelBatch)!(event, job.id)).toEqual({ ok: true, value: false });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("defers repeated window closes until the current image is fully saved, then closes and skips the remainder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clarune-close-batch-test-"));
    try {
      const events: string[] = [];
      let bytesAtClose: Buffer | undefined;
      let savedSize = 0;
      const owner = closableWindow(() => { bytesAtClose = readFileSync(join(dir, "first.png")); events.push("closed"); });
      mocks.fromWebContents.mockReturnValue(owner);
      const lifecycle = registerImageTools(() => owner);
      protectOutputClose(owner, lifecycle);
      const outputFrame = { send: vi.fn((_channel, progress) => {
        if (progress.currentName === "first.png") {
          events.push("close requested");
          owner.close(); owner.close();
          expect(owner.isDestroyed()).toBe(false);
        }
        if (progress.item?.status === "saved") { events.push("saved"); savedSize = progress.item.file.size; }
      }) };
      const outputEvent = { sender: { mainFrame: outputFrame }, senderFrame: outputFrame } as unknown as IpcMainInvokeEvent;
      mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [dir] });
      const bytes = await sharp({ create: { width: 100, height: 80, channels: 3, background: "red" } }).png().toBuffer();
      const result = await mocks.handlers.get(IMAGE_TOOL_CHANNELS.batch)!(outputEvent, { id: "close-batch", images: ["first.png", "second.png"].map((name, index) => ({ id: String(index), name, bytes, options: { format: "png", quality: 100 } })) }) as { ok: boolean; value: { canceled: boolean; items: Array<{ status: string }> } };
      expect(result.ok).toBe(true);
      expect(result.value.canceled).toBe(true);
      expect(result.value.items.map((item) => item.status)).toEqual(["saved", "canceled"]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events).toEqual(["close requested", "saved", "closed"]);
      expect(owner.isDestroyed()).toBe(true);
      expect(bytesAtClose?.length).toBe(savedSize);
      expect(await sharp(bytesAtClose!).ensureAlpha().raw().toBuffer()).toEqual(await sharp(bytes).ensureAlpha().raw().toBuffer());
      expect((await sharp(bytesAtClose!).metadata()).width).toBe(100);
      expect(await readdir(dir)).toEqual(["first.png"]);
      expect(lifecycle.requestOutputStop()).toBeNull();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("allows an owner to close immediately while the folder dialog is pending and never starts writing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clarune-dialog-close-test-"));
    try {
      const owner = closableWindow();
      mocks.fromWebContents.mockReturnValue(owner);
      const lifecycle = registerImageTools(() => owner);
      protectOutputClose(owner, lifecycle);
      let resolveDialog!: (value: unknown) => void;
      mocks.showOpenDialog.mockReturnValueOnce(new Promise((resolve) => { resolveDialog = resolve; }));
      const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: "white" } }).png().toBuffer();
      const pending = mocks.handlers.get(IMAGE_TOOL_CHANNELS.batch)!(event, { id: "picker-close", images: [{ id: "1", name: "never.png", bytes, options: { format: "png", quality: 100 } }] });
      owner.close();
      expect(owner.isDestroyed()).toBe(true);
      resolveDialog({ canceled: false, filePaths: [dir] });
      await pending;
      expect(await readdir(dir)).toEqual([]);
      expect(lifecycle.requestOutputStop()).toBeNull();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it.each(["image", "pdf"])("finishes a real %s output when close is requested immediately after choosing its path", async (kind) => {
    const dir = await mkdtemp(join(tmpdir(), "clarune-close-single-test-"));
    try {
      const path = join(dir, kind === "pdf" ? "export.pdf" : "export.png");
      let bytesAtClose: Buffer | undefined;
      const owner = closableWindow(() => { bytesAtClose = readFileSync(path); });
      mocks.fromWebContents.mockReturnValue(owner);
      const lifecycle = registerImageTools(() => owner);
      protectOutputClose(owner, lifecycle);
      const bytes = await sharp({ create: { width: 500, height: 400, channels: 3, background: "red" } }).png().toBuffer();
      let closed!: () => void;
      const closeRequested = new Promise<void>((resolve) => { closed = resolve; });
      mocks.showSaveDialog.mockImplementationOnce(async () => {
        setTimeout(() => { owner.close(); owner.close(); closed(); }, 0);
        return { canceled: false, filePath: path };
      });
      const job = kind === "pdf" ? { images: [{ name: "fixture.png", bytes }], pageSize: "image", quality: 90 } : { bytes, options: { format: "png", quality: 100 } };
      const result = await mocks.handlers.get(kind === "pdf" ? IMAGE_TOOL_CHANNELS.pdf : IMAGE_TOOL_CHANNELS.save)!(event, job, "export");
      await closeRequested;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(result).toMatchObject({ ok: true, value: { path } });
      expect(owner.isDestroyed()).toBe(true);
      expect(bytesAtClose?.length).toBeGreaterThan(0);
      if (kind === "pdf") expect((await PDFDocument.load(bytesAtClose!)).getPageCount()).toBe(1);
      else expect((await sharp(bytesAtClose!).raw().toBuffer({ resolveWithObject: true })).info.width).toBe(500);
      expect(await readdir(dir)).toEqual([kind === "pdf" ? "export.pdf" : "export.png"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("permits reveal/copy only for outputs generated by the trusted app", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clarune-open-output-test-"));
    try {
      registerImageTools(() => window);
      mocks.fromWebContents.mockReturnValue(window);
      const path = join(dir, "image.png");
      expect(await mocks.handlers.get(IMAGE_TOOL_CHANNELS.openOutput)!(event, path)).toEqual({ ok: false, error: "OUTPUT_NOT_FOUND" });
      expect(await mocks.handlers.get(IMAGE_TOOL_CHANNELS.copyOutputPath)!(event, "cmd.exe")).toEqual({ ok: false, error: "INVALID_OPTIONS" });
      mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: path });
      const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: "white" } }).png().toBuffer();
      expect(await mocks.handlers.get(IMAGE_TOOL_CHANNELS.save)!(event, { bytes, options: { format: "png", quality: 100 } }, "image")).toMatchObject({ ok: true });
      expect(await mocks.handlers.get(IMAGE_TOOL_CHANNELS.openOutput)!(event, path)).toEqual({ ok: true, value: null });
      expect(mocks.showItemInFolder).toHaveBeenLastCalledWith(path);
      expect(await mocks.handlers.get(IMAGE_TOOL_CHANNELS.copyOutputPath)!(event, path)).toEqual({ ok: true, value: null });
      expect(mocks.writeText).toHaveBeenLastCalledWith(path);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it.each(["image", "pdf"])("closes without writing when the %s save picker is still pending", async (kind) => {
    const dir = await mkdtemp(join(tmpdir(), "clarune-save-picker-close-"));
    try {
      const owner = closableWindow();
      mocks.fromWebContents.mockReturnValue(owner);
      const lifecycle = registerImageTools(() => owner);
      protectOutputClose(owner, lifecycle);
      let select!: (value: unknown) => void;
      let opened!: () => void;
      const pickerOpened = new Promise<void>((resolve) => { opened = resolve; });
      mocks.showSaveDialog.mockImplementationOnce(() => { opened(); return new Promise((resolve) => { select = resolve; }); });
      const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: "white" } }).png().toBuffer();
      const job = kind === "pdf" ? { images: [{ name: "fixture.png", bytes }], pageSize: "image", quality: 90 } : { bytes, options: { format: "png", quality: 100 } };
      const pending = mocks.handlers.get(kind === "pdf" ? IMAGE_TOOL_CHANNELS.pdf : IMAGE_TOOL_CHANNELS.save)!(event, job, "export");
      await pickerOpened;
      owner.close();
      expect(owner.isDestroyed()).toBe(true);
      select({ canceled: false, filePath: join(dir, kind === "pdf" ? "never.pdf" : "never.png") });
      expect(await pending).toEqual({ ok: false, error: "CANCELED", canceled: true });
      expect(await readdir(dir)).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
