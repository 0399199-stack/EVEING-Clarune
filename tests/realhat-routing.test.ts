import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImageToolError } from "../src/main/image-tools/errors";
import type { UpscaleExecution } from "../src/main/upscale/native-process";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), getRuntime: vi.fn(), getStatus: vi.fn(), selectRuntime: vi.fn() }));
vi.mock("../src/main/upscale/realhat-process", () => ({ executeRealHat: mocks.execute }));
vi.mock("../src/main/upscale/realhat-runtime", () => ({ getRealHatRuntime: mocks.getRuntime, getRealHatStatus: mocks.getStatus, selectRealHatRuntime: mocks.selectRuntime }));
import { configureUpscaleRuntime, getUpscaleStatus, selectUpscaleRuntime, upscaleImage } from "../src/main/upscale/runtime";

const options = { model: "real-hat-x4" as const, scale: 4 as const, tileSize: 128 as const };
const runtime = { pythonExecutable: "C:\\python.exe", worker: "C:\\resources\\realhat-worker.py", weight: "C:\\model.pth" };
let source: Buffer;
beforeEach(async () => {
  vi.clearAllMocks(); mocks.getRuntime.mockResolvedValue(runtime);
  source = await sharp({ create: { width: 12, height: 9, channels: 4, background: { r: 50, g: 120, b: 220, alpha: 0.5 } } }).png().toBuffer();
  mocks.execute.mockImplementation(async (_runtime, input: string, output: string) => {
    const scaled = await sharp(await readFile(input)).resize(48, 36).png().toBuffer();
    await writeFile(output, scaled);
  });
});

describe("shared AI pipeline with Real-HAT routing", () => {
  it.each([2, 3, 4] as const)("retains native 4x, decodes and scales to %sx without needing the ncnn runtime", async (scale) => {
    const output = await upscaleImage(source, 12, 9, { ...options, scale });
    const image = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    expect([image.info.width, image.info.height, image.info.channels]).toEqual([12 * scale, 9 * scale, 4]);
    expect(image.data[3]).toBeGreaterThan(120); expect(image.data[3]).toBeLessThan(135);
    const [selected, input, target, tile] = mocks.execute.mock.lastCall!;
    expect(selected).toBe(runtime); expect(tile).toBe(128);
    expect(input).toMatch(/input\.png$/); expect(target).toMatch(/output\.png$/);
    expect(await stat(dirname(input)).catch(() => null)).toBeNull();
  });
  it("routes status and selection to the independent external registration", async () => {
    const state = { ready: true, localOnly: true };
    mocks.getStatus.mockResolvedValue(state); mocks.selectRuntime.mockResolvedValue(state);
    expect(await getUpscaleStatus("real-hat-x4")).toBe(state);
    expect(await selectUpscaleRuntime("C:\\chosen", "real-hat-x4")).toBe(state);
    expect(mocks.selectRuntime).toHaveBeenLastCalledWith("C:\\chosen");
  });
  it("rejects invalid inference dimensions and cleans owned temporary files on error", async () => {
    let input = "";
    mocks.execute.mockImplementationOnce(async (_runtime, sourcePath: string, target: string) => { input = sourcePath; await writeFile(target, source); });
    await expect(upscaleImage(source, 12, 9, options)).rejects.toThrow("UPSCALE_INVALID_OUTPUT");
    expect(await stat(dirname(input)).catch(() => null)).toBeNull();
    await expect(upscaleImage(source, 2000, 1500, options)).rejects.toThrow("UPSCALE_INPUT_TOO_LARGE");
    expect(mocks.execute).toHaveBeenCalledOnce();
  });
  it("holds the shared busy guard and owned files until canceled Real-HAT cleanup completes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clarune-route-test-"));
    try {
      const registry = join(directory, "registry.json");
      await writeFile(registry, JSON.stringify({ directory }));
      configureUpscaleRuntime(registry);
      let entered!: () => void, finish!: () => void, input = "";
      const started = new Promise<void>((resolve) => { entered = resolve; });
      mocks.execute.mockImplementationOnce((_runtime, inputPath: string, _target: string, _tile: number, execution: UpscaleExecution) => new Promise<void>((_resolve, reject) => {
        input = inputPath; entered(); finish = () => { expect(execution.signal?.aborted).toBe(true); reject(new ImageToolError("CANCELED")); };
      }));
      const abort = new AbortController();
      const result = upscaleImage(source, 12, 9, options, { signal: abort.signal }).catch((error: Error) => error.message);
      await started; abort.abort();
      expect((await stat(input)).isFile()).toBe(true);
      await expect(upscaleImage(source, 12, 9, options)).rejects.toThrow("BUSY");
      await expect(upscaleImage(source, 12, 9, { ...options, model: "realesrgan-x4plus" })).rejects.toThrow("BUSY");
      finish(); expect(await result).toBe("CANCELED");
      expect(await stat(dirname(input)).catch(() => null)).toBeNull();
      await expect(upscaleImage(source, 12, 9, options)).resolves.toBeInstanceOf(Buffer);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
