import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnhancementProgress } from "../src/shared/image-tools";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { executeRealHat, probeRealHat } from "../src/main/upscale/realhat-process";

const runtime = { pythonExecutable: "C:\\python\\python.exe", worker: "C:\\Clarune\\resources\\realhat-worker.py", weight: "C:\\selected\\models\\Real_HAT_GAN_SRx4.pth" };
let child: EventEmitter & { stdout: EventEmitter; kill: ReturnType<typeof vi.fn> };
const record = (value: object) => child.stdout.emit("data", Buffer.from(`CLARUNE_REALHAT ${JSON.stringify(value)}\n`));
beforeEach(() => {
  child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: vi.fn() });
  mocks.spawn.mockReset().mockReturnValue(child);
});
afterEach(() => { vi.useRealTimers(); });

describe("isolated Real-HAT worker", () => {
  it("uses only fixed arguments and isolates Python imports from the runtime/current directory", async () => {
    const progress: Array<Omit<EnhancementProgress, "id">> = [];
    const pending = executeRealHat(runtime, "C:\\temp\\input.png", "C:\\temp\\output.png", 256, { onProgress: (value) => progress.push(value) });
    const [exe, args, config] = mocks.spawn.mock.lastCall!;
    expect(exe).toBe(runtime.pythonExecutable);
    expect(args).toEqual(["-I", "-B", "-u", runtime.worker, "--model", runtime.weight, "--input", "C:\\temp\\input.png", "--output", "C:\\temp\\output.png", "--tile", "256"]);
    expect(config).toMatchObject({ cwd: "C:\\Clarune\\resources", shell: false, windowsHide: true });
    expect(config.env).not.toHaveProperty("PYTHONPATH"); expect(config.env).not.toHaveProperty("PYTHONHOME");
    child.stdout.emit("data", Buffer.from('chatter\nCLARUNE_REALHAT {"type":"progress","percent":2'));
    child.stdout.emit("data", Buffer.from('5}\n'));
    for (const percent of [-1, 1001, "30", 10, 25, 60]) record({ type: "progress", percent });
    child.emit("close", 0); await pending;
    expect(progress).toEqual([25, 60].map((percent) => ({ stage: "inference", percent })));
  });
  it("requires a real CUDA/HAT ready response, not just exit zero", async () => {
    let pending = probeRealHat(runtime);
    child.emit("close", 0); await expect(pending).rejects.toThrow("REALHAT_ENGINE_FAILED");
    pending = probeRealHat(runtime);
    record({ type: "ready", architecture: "HAT", scale: 4, cuda: true });
    child.emit("close", 0); await pending;
    expect(mocks.spawn.mock.lastCall![1]).toEqual(["-I", "-B", "-u", runtime.worker, "--probe"]);
  });
  it("terminates a slow capability probe and waits for child close before releasing shutdown", async () => {
    const abort = new AbortController();
    let settled = false;
    const pending = probeRealHat(runtime, { signal: abort.signal }).catch((error: Error) => { settled = true; return error.message; });
    abort.abort(); await Promise.resolve();
    expect(child.kill).toHaveBeenCalledOnce(); expect(settled).toBe(false);
    record({ type: "ready", architecture: "HAT", scale: 4, cuda: true });
    child.emit("close", 0); expect(await pending).toBe("CANCELED");
    await expect(probeRealHat(runtime, { signal: abort.signal })).rejects.toThrow("CANCELED");
    expect(mocks.spawn).toHaveBeenCalledOnce();
  });
  it.each(["REALHAT_DEPENDENCIES_MISSING", "REALHAT_CUDA_UNAVAILABLE", "REALHAT_OUT_OF_MEMORY", "REALHAT_RUNTIME_UNVERIFIED"])("returns the explicit %s without falling back to another model", async (code) => {
    const pending = executeRealHat(runtime, "in.png", "out.png", 128);
    record({ type: "error", code }); child.emit("close", 1);
    await expect(pending).rejects.toThrow(code); expect(mocks.spawn).toHaveBeenCalledOnce();
  });
  it("sanitizes unknown errors and waits for close following spawn errors", async () => {
    let settled = false;
    const result = executeRealHat(runtime, "in.png", "out.png", 128).catch((error: Error) => { settled = true; return error.message; });
    record({ type: "error", code: "secret local path" });
    child.emit("error", new Error("private environment error")); await Promise.resolve(); expect(settled).toBe(false);
    child.emit("close", 1); expect(await result).toBe("REALHAT_ENGINE_FAILED");
  });
  it("kills only the owned process, suppresses subsequent progress, and waits for close on cancel", async () => {
    const abort = new AbortController(), onProgress = vi.fn();
    let settled = false;
    const result = executeRealHat(runtime, "in.png", "out.png", 128, { signal: abort.signal, onProgress }).catch((error: Error) => { settled = true; return error.message; });
    abort.abort(); record({ type: "progress", percent: 50 }); await Promise.resolve();
    expect(child.kill).toHaveBeenCalledOnce(); expect(onProgress).not.toHaveBeenCalled(); expect(settled).toBe(false);
    child.emit("close", 1); expect(await result).toBe("CANCELED");
    await expect(executeRealHat(runtime, "in.png", "out.png", 128, { signal: abort.signal })).rejects.toThrow("CANCELED");
    expect(mocks.spawn).toHaveBeenCalledOnce();
  });
  it.each([true, false])("bounds probe/inference time and waits for child close (probe=%s)", async (probe) => {
    vi.useFakeTimers();
    let settled = false;
    const pending = (probe ? probeRealHat(runtime) : executeRealHat(runtime, "in.png", "out.png", 128)).catch((error: Error) => { settled = true; return error.message; });
    await vi.advanceTimersByTimeAsync(probe ? 60_000 : 20 * 60_000);
    expect(child.kill).toHaveBeenCalledOnce(); expect(settled).toBe(false);
    child.emit("close", 1); expect(await pending).toBe("UPSCALE_TIMEOUT");
  });
});
