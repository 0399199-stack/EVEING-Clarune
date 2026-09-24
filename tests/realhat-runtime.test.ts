import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImageToolError } from "../src/main/image-tools/errors";

const mocks = vi.hoisted(() => ({ readFile: vi.fn(), lstat: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), rename: vi.fn(), rm: vi.fn(), probe: vi.fn(), digest: vi.fn(), update: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile, lstat: mocks.lstat, writeFile: mocks.writeFile, mkdir: mocks.mkdir, rename: mocks.rename, rm: mocks.rm }));
vi.mock("node:crypto", () => ({ createHash: () => ({ update: mocks.update }) }));
vi.mock("../src/main/upscale/realhat-process", () => ({ probeRealHat: mocks.probe }));
import { configureRealHatRuntime, getRealHatRuntime, getRealHatStatus, REALHAT_WEIGHT_SHA256, selectRealHatRuntime, stopRealHatProbes, verifyRealHatRuntime } from "../src/main/upscale/realhat-runtime";

const root = "C:\\selected", python = "D:\\python\\python.exe", worker = "C:\\Clarune\\resources\\realhat-worker.py", registry = "C:\\profile\\realhat-runtime.json";
const absent = () => Object.assign(new Error("missing"), { code: "ENOENT" });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.digest.mockReturnValue(REALHAT_WEIGHT_SHA256); mocks.update.mockReturnValue({ digest: mocks.digest });
  mocks.probe.mockResolvedValue(undefined); mocks.writeFile.mockResolvedValue(undefined); mocks.mkdir.mockResolvedValue(undefined); mocks.rename.mockResolvedValue(undefined); mocks.rm.mockResolvedValue(undefined);
  mocks.lstat.mockImplementation(async (path: string) => ({ isFile: () => path !== root, isDirectory: () => path === root, size: path.endsWith(".pth") ? 170_277_017 : 100, mtimeMs: 1 }));
  mocks.readFile.mockImplementation(async (path: string) => {
    if (path === registry) return Buffer.from(JSON.stringify({ directory: root }));
    if (path.endsWith("clarune-realhat.json")) return JSON.stringify({ pythonExecutable: python });
    if (path.endsWith(".pth")) return Buffer.from("test-only mocked weight");
    throw absent();
  });
});

describe("verified external Real-HAT configuration", () => {
  it.each(["registry", "manifest", "weight"])("never starts a probe after close during a pending %s read", async (stage) => {
    const original = mocks.readFile.getMockImplementation()!;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocks.readFile.mockImplementation(async (path: string) => {
      if ((stage === "registry" && path === registry) || (stage === "manifest" && path.endsWith("clarune-realhat.json")) || (stage === "weight" && path.endsWith(".pth"))) { entered(); await gate; }
      return original(path);
    });
    configureRealHatRuntime(registry, worker);
    const status = getRealHatStatus(); await started;
    expect(stopRealHatProbes()).toBeNull(); release();
    expect(await status).toEqual({ ready: false, localOnly: true, reason: "CANCELED" });
    expect(mocks.probe).not.toHaveBeenCalled();
    // Closing capability checks must not prevent the current batch from completing.
    expect(await getRealHatRuntime()).toMatchObject({ pythonExecutable: python });
    expect(mocks.probe).not.toHaveBeenCalled();
  });
  it("aborts and waits for a slow shared probe, preventing directory persistence after close", async () => {
    let entered!: () => void, close!: () => void, signal: AbortSignal | undefined;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    mocks.probe.mockImplementationOnce((_runtime, execution: { signal: AbortSignal }) => new Promise<void>((_resolve, reject) => {
      signal = execution.signal; entered(); close = () => reject(new ImageToolError("CANCELED"));
    }));
    configureRealHatRuntime(registry, worker);
    const selection = selectRealHatRuntime(root).catch((error: Error) => error.message);
    await started;
    let stopped = false;
    const pending = stopRealHatProbes(); expect(pending).not.toBeNull(); void pending!.then(() => { stopped = true; });
    await Promise.resolve(); expect(signal?.aborted).toBe(true); expect(stopped).toBe(false);
    close(); await pending; expect(stopped).toBe(true); expect(await selection).toBe("CANCELED");
    expect(mocks.writeFile).not.toHaveBeenCalled(); expect(stopRealHatProbes()).toBeNull();
    expect(await getRealHatStatus()).toMatchObject({ ready: false, reason: "CANCELED" }); expect(mocks.probe).toHaveBeenCalledOnce();
    configureRealHatRuntime(registry, worker);
    expect(await getRealHatStatus()).toMatchObject({ ready: true }); expect(mocks.probe).toHaveBeenCalledTimes(2);
  });
  it("keeps configuration independent and caches dependency probes but never checkpoint verification", async () => {
    configureRealHatRuntime(registry, worker);
    expect(await getRealHatStatus()).toMatchObject({ ready: true, source: "selected", localOnly: true });
    expect(await getRealHatStatus()).toMatchObject({ ready: true });
    expect(mocks.probe).toHaveBeenCalledOnce();
    expect(mocks.digest).toHaveBeenCalledTimes(2);
    const result = await getRealHatRuntime();
    expect(result).toEqual({ pythonExecutable: python, worker, weight: join(root, "models", "Real_HAT_GAN_SRx4.pth") });
    expect(mocks.digest).toHaveBeenCalledTimes(3); expect(mocks.probe).toHaveBeenCalledOnce();
    mocks.digest.mockReturnValue("wrong");
    await expect(getRealHatRuntime()).rejects.toThrow("REALHAT_RUNTIME_UNVERIFIED");
  });
  it("invalidates the dependency cache if the interpreter changes", async () => {
    configureRealHatRuntime(registry, worker); await getRealHatStatus();
    mocks.lstat.mockImplementation(async (path: string) => ({ isFile: () => path !== root, isDirectory: () => path === root, size: path.endsWith(".pth") ? 170_277_017 : 100, mtimeMs: path === python ? 2 : 1 }));
    await getRealHatStatus(); expect(mocks.probe).toHaveBeenCalledTimes(2);
  });
  it.each(["REALHAT_DEPENDENCIES_MISSING", "REALHAT_CUDA_UNAVAILABLE"])("exposes %s from the real capability probe", async (reason) => {
    mocks.probe.mockRejectedValue(new ImageToolError(reason));
    configureRealHatRuntime(registry, worker);
    expect(await getRealHatStatus()).toEqual({ ready: false, localOnly: true, reason });
  });
  it("detects only the app-supplied candidate when no explicit registry exists", async () => {
    const original = mocks.readFile.getMockImplementation()!;
    mocks.readFile.mockImplementation(async (path: string) => { if (path === registry) throw absent(); return original(path); });
    configureRealHatRuntime(registry, worker, [root]);
    expect(await getRealHatStatus()).toMatchObject({ ready: true, source: "detected" });
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
  it.each(["{malformed", JSON.stringify({ directory: "relative" }), JSON.stringify({ directory: "C:\\missing" })])("never falls back from an invalid explicit selection", async (entry) => {
    const original = mocks.readFile.getMockImplementation()!;
    mocks.readFile.mockImplementation(async (path: string) => path === registry ? Buffer.from(entry) : original(path));
    configureRealHatRuntime(registry, worker, [root]);
    expect((await getRealHatStatus()).ready).toBe(false);
    expect(mocks.readFile.mock.calls.some(([path]) => path === join(root, "clarune-realhat.json"))).toBe(false);
    expect(mocks.probe).not.toHaveBeenCalled();
  });
  it.each(["../python.exe", "C:\\python\\run.cmd", 123, null])("rejects an unsafe interpreter before any execution (%s)", async (pythonExecutable) => {
    configureRealHatRuntime(registry, worker);
    const original = mocks.readFile.getMockImplementation()!;
    mocks.readFile.mockImplementation(async (path: string) => path.endsWith("clarune-realhat.json") ? JSON.stringify({ pythonExecutable }) : original(path));
    await expect(verifyRealHatRuntime(root)).rejects.toThrow("REALHAT_RUNTIME_UNVERIFIED");
    expect(mocks.probe).not.toHaveBeenCalled();
  });
  it("persists only a verified directory, and reports registry writing failures", async () => {
    configureRealHatRuntime(registry, worker);
    expect(await selectRealHatRuntime(root)).toMatchObject({ ready: true, source: "selected" });
    expect(mocks.writeFile).toHaveBeenCalledWith(`${registry}.tmp`, JSON.stringify({ directory: root, localOnly: true }), { mode: 0o600 });
    mocks.rename.mockRejectedValueOnce(new Error("disk full"));
    await expect(selectRealHatRuntime(root)).rejects.toThrow("UPSCALE_RUNTIME_SAVE_FAILED");
    expect(mocks.rm).toHaveBeenCalledWith(`${registry}.tmp`, { force: true });
  });
});
