import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { IMAGE_TOOL_CHANNELS, type UpscaleOptions } from "../src/shared/image-tools";
import { IPC_CHANNELS } from "../src/shared/contracts";
import { ImageToolError } from "../src/main/image-tools/errors";
import type { LicenseService } from "../src/main/license/license-service";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(), fromWebContents: vi.fn(),
  showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), upscale: vi.fn(), status: vi.fn(), stopProbes: vi.fn(), writeText: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { getPath: () => process.env.TEMP || process.env.TMP || "/tmp" },
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => mocks.handlers.set(channel, handler) },
  dialog: { showOpenDialog: mocks.showOpenDialog, showSaveDialog: mocks.showSaveDialog },
  clipboard: { writeText: mocks.writeText }, shell: {},
}));
vi.mock("../src/main/upscale/runtime", () => ({ configureUpscaleRuntime: vi.fn(), getUpscaleStatus: mocks.status, selectUpscaleRuntime: vi.fn(), upscaleImage: mocks.upscale }));
vi.mock("../src/main/upscale/realhat-runtime", () => ({ configureRealHatRuntime: vi.fn(), stopRealHatProbes: mocks.stopProbes }));
import { registerImageTools } from "../src/main/image-tools/ipc";
import { registerLicenseIpc } from "../src/main/license-ipc";
import { protectOutputClose } from "../src/main/image-tools/window-close";

function closableWindow(): BrowserWindow {
  let destroyed = false;
  const listeners: Array<(event: { preventDefault(): void }) => void> = [];
  return {
    isDestroyed: () => destroyed, webContents: { on: vi.fn() },
    on: (_name: string, listener: (event: { preventDefault(): void }) => void) => { listeners.push(listener); },
    close: () => {
      let prevented = false;
      listeners.forEach((listener) => listener({ preventDefault: () => { prevented = true; } }));
      if (!prevented) destroyed = true;
    },
  } as unknown as BrowserWindow;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const frame = { send: vi.fn() };
const event = { sender: { mainFrame: frame }, senderFrame: frame } as unknown as IpcMainInvokeEvent;
const settings: UpscaleOptions = { model: "realesrgan-x4plus", scale: 4, tileSize: 128 };
const options = { format: "png" as const, quality: 100 };
const call = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!(event, ...args);
const folders: string[] = [];
let source: Buffer, directory: string, owner: BrowserWindow;

beforeEach(async () => {
  for (const mock of Object.values(mocks)) if (vi.isMockFunction(mock)) mock.mockReset();
  mocks.handlers.clear(); frame.send.mockClear();
  owner = closableWindow(); mocks.fromWebContents.mockReturnValue(owner);
  mocks.stopProbes.mockReturnValue(null);
  mocks.status.mockResolvedValue({ ready: true, localOnly: true });
  directory = await mkdtemp(join(tmpdir(), "clarune-license-gate-")); folders.push(directory);
  mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [directory] });
  mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: join(directory, "output") });
  source = await sharp({ create: { width: 12, height: 8, channels: 3, background: "red" } }).png().toBuffer();
  mocks.upscale.mockImplementation((bytes: Buffer, width: number, height: number, options: UpscaleOptions) => sharp(bytes).resize(width * options.scale, height * options.scale).png().toBuffer());
});
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

function invokeOperation(kind: "image" | "pdf" | "batch" | "AI", extraOptions = {}) {
  if (kind === "image") return call(IMAGE_TOOL_CHANNELS.save, { bytes: source, options: { ...options, ...extraOptions } }, "output");
  if (kind === "pdf") return call(IMAGE_TOOL_CHANNELS.pdf, { images: [{ name: "image.png", bytes: source }], pageSize: "image", quality: 90 }, "output");
  if (kind === "batch") return call(IMAGE_TOOL_CHANNELS.batch, { id: "batch", images: [{ id: "one", name: "image.png", bytes: source, options: { ...options, ...extraOptions } }] });
  return call(IMAGE_TOOL_CHANNELS.enhance, { id: "AI", bytes: source, upscale: settings });
}

describe("main-process activation gate", () => {
  it("defaults to denying real AI, image export, PDF export and batch without opening a picker or creating a file", async () => {
    registerImageTools(() => owner);
    for (const kind of ["AI", "image", "pdf", "batch"] as const) {
      expect(await invokeOperation(kind)).toEqual({ ok: false, error: "LICENSE_REQUIRED" });
    }
    expect(mocks.upscale).not.toHaveBeenCalled();
    expect(mocks.showOpenDialog).not.toHaveBeenCalled();
    expect(mocks.showSaveDialog).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it("keeps unlicensed editing previews and capability inspection available but strips AI options", async () => {
    const gate = vi.fn(async () => { throw new ImageToolError("LICENSE_REQUIRED"); });
    registerImageTools(() => owner, undefined, [], undefined, gate);
    expect(await call(IMAGE_TOOL_CHANNELS.process, { bytes: source, options: { ...options, rotation: 90, upscale: settings } }))
      .toMatchObject({ ok: true, value: { width: 8, height: 12 } });
    expect(await call(IMAGE_TOOL_CHANNELS.upscaleStatus, "real-hat-x4")).toMatchObject({ ok: true, value: { ready: true } });
    expect(gate).not.toHaveBeenCalled(); expect(mocks.upscale).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(["image", "pdf"] as const)("rechecks activation before publishing a %s output", async (kind) => {
    const gate = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ImageToolError("LICENSE_REQUIRED"));
    registerImageTools(() => owner, undefined, [], undefined, gate);
    expect(await invokeOperation(kind)).toEqual({ ok: false, error: "LICENSE_REQUIRED" });
    expect(gate).toHaveBeenCalledTimes(2);
    expect(mocks.showSaveDialog).toHaveBeenCalledOnce();
    expect(await readdir(directory)).toEqual([]);
  });

  it("rechecks every batch item before work and before publishing", async () => {
    const gate = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ImageToolError("LICENSE_REQUIRED")).mockRejectedValue(new ImageToolError("LICENSE_REQUIRED"));
    registerImageTools(() => owner, undefined, [], undefined, gate);
    const result = await call(IMAGE_TOOL_CHANNELS.batch, { id: "batch", images: ["one", "two"].map(id => ({ id, name: `${id}.png`, bytes: source, options: { ...options, upscale: settings } })) });
    expect(result).toMatchObject({ ok: true, value: { items: [{ status: "failed", error: "LICENSE_REQUIRED" }, { status: "failed", error: "LICENSE_REQUIRED" }] } });
    expect(mocks.upscale).toHaveBeenCalledOnce(); expect(gate).toHaveBeenCalledTimes(4);
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(["image", "pdf", "batch", "AI"] as const)("closing during the initial %s authorization check never starts output or inference", async (kind) => {
    const ready = deferred(), authorization = deferred();
    const lifecycle = registerImageTools(() => owner, undefined, [], undefined, async () => { ready.resolve(); await authorization.promise; });
    protectOutputClose(owner, lifecycle);
    const pending = invokeOperation(kind);
    await ready.promise; owner.close(); authorization.resolve();
    expect(await pending).toEqual({ ok: false, error: "CANCELED", canceled: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(owner.isDestroyed()).toBe(true);
    expect(mocks.showOpenDialog).not.toHaveBeenCalled(); expect(mocks.showSaveDialog).not.toHaveBeenCalled();
    expect(mocks.upscale).not.toHaveBeenCalled(); expect(await readdir(directory)).toEqual([]);
  });

  it.each(["image", "pdf"] as const)("closing while the final %s authorization is pending prevents a not-yet-started write", async (kind) => {
    const ready = deferred(), authorization = deferred();
    let calls = 0;
    const lifecycle = registerImageTools(() => owner, undefined, [], undefined, async () => {
      if (++calls === 2) { ready.resolve(); await authorization.promise; }
    });
    protectOutputClose(owner, lifecycle);
    const pending = invokeOperation(kind);
    await ready.promise; owner.close(); authorization.resolve();
    expect(await pending).toEqual({ ok: false, error: "CANCELED", canceled: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(owner.isDestroyed()).toBe(true); expect(await readdir(directory)).toEqual([]);
  });

  it("does not begin batch inference after close was requested during an item authorization check", async () => {
    const ready = deferred(), authorization = deferred();
    let calls = 0;
    const lifecycle = registerImageTools(() => owner, undefined, [], undefined, async () => {
      if (++calls === 2) { ready.resolve(); await authorization.promise; }
    });
    protectOutputClose(owner, lifecycle);
    const pending = invokeOperation("batch", { upscale: settings });
    await ready.promise; owner.close(); authorization.resolve();
    expect(await pending).toMatchObject({ ok: true, value: { canceled: true, items: [{ status: "canceled" }] } });
    expect(mocks.upscale).not.toHaveBeenCalled(); expect(await readdir(directory)).toEqual([]);
  });

  it("refuses to release full AI output when activation expires during inference", async () => {
    const gate = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ImageToolError("LICENSE_REQUIRED"));
    registerImageTools(() => owner, undefined, [], undefined, gate);
    expect(await invokeOperation("AI")).toEqual({ ok: false, error: "LICENSE_REQUIRED" });
    expect(mocks.upscale).toHaveBeenCalledOnce(); expect(await readdir(directory)).toEqual([]);
  });

  it("validates activation IPC sender and length before invoking the service", async () => {
    const service = { activate: vi.fn(), getStatus: vi.fn().mockResolvedValue({ state: "inactive", machineCode: "REQUEST" }) };
    registerLicenseIpc(() => owner, service as unknown as LicenseService);
    expect(await call(IPC_CHANNELS.licenseActivate, "x".repeat(16_385))).toMatchObject({ state: "invalid" });
    expect(await call(IPC_CHANNELS.licenseActivate, null)).toMatchObject({ state: "invalid" });
    expect(service.activate).not.toHaveBeenCalled();
    await expect(mocks.handlers.get(IPC_CHANNELS.licenseStatus)!({ ...event, senderFrame: {} })).rejects.toThrow("Untrusted");
    expect(service.getStatus).not.toHaveBeenCalled();
    expect(await call(IPC_CHANNELS.licenseCopyMachine)).toBe(true);
    expect(mocks.writeText).toHaveBeenCalledWith("REQUEST");
  });

  it("closes the license IPC admission gate before waiting, so new requests cannot enqueue a late write", async () => {
    const persistence = deferred();
    let writes = 0;
    const completed = persistence.promise.then(() => { writes++; return { state: "active" }; });
    const service = { activate: vi.fn(() => completed), getStatus: vi.fn(), whenIdle: () => completed.then(() => undefined) };
    const admission = registerLicenseIpc(() => owner, service as unknown as LicenseService);
    protectOutputClose(owner, { requestOutputStop: () => { admission.stopAcceptingRequests(); return service.whenIdle(); } });
    const accepted = call(IPC_CHANNELS.licenseActivate, "already accepted");
    owner.close();
    expect(owner.isDestroyed()).toBe(false);
    for (const channel of [IPC_CHANNELS.licenseActivate, IPC_CHANNELS.licenseStatus, IPC_CHANNELS.licenseCopyMachine]) {
      await expect(call(channel, "too late")).rejects.toThrow("Application is closing");
    }
    expect(service.activate).toHaveBeenCalledOnce(); expect(writes).toBe(0);
    persistence.resolve(); await accepted;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(writes).toBe(1); expect(owner.isDestroyed()).toBe(true);
    await Promise.resolve(); expect(writes).toBe(1);
  });

  it("does not modify the clipboard if shutdown begins during a machine-code lookup", async () => {
    const lookup = deferred<{ state: string; machineCode: string }>();
    const service = { getStatus: () => lookup.promise };
    const admission = registerLicenseIpc(() => owner, service as unknown as LicenseService);
    const pending = call(IPC_CHANNELS.licenseCopyMachine);
    admission.stopAcceptingRequests(); lookup.resolve({ state: "inactive", machineCode: "NOT_COPIED" });
    await expect(pending).rejects.toThrow("Application is closing");
    expect(mocks.writeText).not.toHaveBeenCalled();
  });

  it("admits no new output or AI requests while shutdown waits for an earlier authorization", async () => {
    const ready = deferred(), authorization = deferred();
    const gate = vi.fn(async () => { ready.resolve(); await authorization.promise; });
    const lifecycle = registerImageTools(() => owner, undefined, [], undefined, gate);
    const first = invokeOperation("image");
    await ready.promise;
    const stopping = lifecycle.requestOutputStop();
    for (const kind of ["image", "pdf", "batch", "AI"] as const) {
      expect(await invokeOperation(kind)).toMatchObject({ ok: false, error: "CANCELED" });
    }
    expect(gate).toHaveBeenCalledOnce();
    authorization.resolve(); await first; await stopping;
    expect(mocks.showOpenDialog).not.toHaveBeenCalled(); expect(mocks.showSaveDialog).not.toHaveBeenCalled();
    expect(mocks.upscale).not.toHaveBeenCalled(); expect(await readdir(directory)).toEqual([]);
  });
});
