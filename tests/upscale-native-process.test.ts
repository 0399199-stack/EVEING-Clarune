import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnhancementProgress } from "../src/shared/image-tools";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { executeUpscale } from "../src/main/upscale/native-process";

const options = { scale: 2 as const, model: "realesrgan-x4plus" as const, tileSize: 128 as const };
let child: EventEmitter & { stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
beforeEach(() => {
  child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: vi.fn() });
  mocks.spawn.mockReset().mockReturnValue(child);
});
afterEach(() => { vi.useRealTimers(); });

describe("owned AI native process", () => {
  it("uses fixed native 4x arguments with no shell, and relays only complete native progress lines", async () => {
    const progress: Array<Omit<EnhancementProgress, "id">> = [];
    const pending = executeUpscale("C:\\runtime", "C:\\temp\\input.png", "C:\\temp\\output.png", options, { onProgress: (item) => progress.push(item) });
    const [exe, args, config] = mocks.spawn.mock.lastCall!;
    expect(exe).toMatch(/realesrgan-ncnn-vulkan\.exe$/);
    expect(args).toContain("models"); expect(args.slice(args.indexOf("-s"), args.indexOf("-s") + 2)).toEqual(["-s", "4"]);
    expect(config).toMatchObject({ cwd: "C:\\runtime", shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.emit("data", Buffer.from("GPU 0 Nvidia\n0.00%\n3"));
    child.stderr.emit("data", Buffer.from("3.33%\r\n1000%\ninvalid 50%\n33.33%\n100.00%\n"));
    child.emit("close", 0); await pending;
    expect(progress).toEqual([0, 33.33, 100].map((percent) => ({ stage: "inference", percent })));
  });
  it("kills only the owned child on cancellation and does not resolve before close", async () => {
    const abort = new AbortController();
    let settled = false;
    const pending = executeUpscale("C:\\runtime", "input.png", "output.png", options, { signal: abort.signal });
    const result = pending.catch((error: Error) => { settled = true; return error.message; });
    abort.abort(); await Promise.resolve();
    expect(child.kill).toHaveBeenCalledOnce(); expect(settled).toBe(false);
    child.emit("close", 1);
    expect(await result).toBe("CANCELED");
  });
  it("does not launch canceled requests, and waits for close after a spawn error", async () => {
    const abort = new AbortController(); abort.abort();
    await expect(executeUpscale("C:\\runtime", "input.png", "output.png", options, { signal: abort.signal })).rejects.toThrow("CANCELED");
    expect(mocks.spawn).not.toHaveBeenCalled();
    let settled = false;
    const result = executeUpscale("C:\\runtime", "input.png", "output.png", options).catch((error: Error) => { settled = true; return error.message; });
    child.emit("error", new Error("spawn failed")); await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("close", -1);
    expect(await result).toBe("UPSCALE_ENGINE_FAILED");
  });
  it("kills timed-out work but waits for close before returning its error", async () => {
    vi.useFakeTimers();
    let settled = false;
    const result = executeUpscale("C:\\runtime", "input.png", "output.png", options).catch((error: Error) => { settled = true; return error.message; });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(child.kill).toHaveBeenCalledOnce(); expect(settled).toBe(false);
    child.emit("close", 1);
    expect(await result).toBe("UPSCALE_TIMEOUT");
  });
});
