import { describe, expect, it, vi } from "vitest";
import type { ClaruneAPI } from "../src/shared/contracts";

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (event: { preventDefault: () => void; returnValue?: string }) => void>();
  (globalThis as unknown as { window: unknown }).window = { addEventListener: (name: string, listener: (event: { preventDefault: () => void }) => void) => listeners.set(name, listener) };
  return { listeners, api: undefined as unknown, invoke: vi.fn() };
});
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: unknown) => { mocks.api = api; } },
  ipcRenderer: { invoke: mocks.invoke, on: vi.fn(), removeListener: vi.fn() },
}));
import "../src/preload/index";

describe("export reload protection", () => {
  it("blocks reload until every pending export resolves, including failures", async () => {
    const api = mocks.api as ClaruneAPI;
    const beforeUnload = () => {
      const event = { preventDefault: vi.fn(), returnValue: undefined as string | undefined };
      mocks.listeners.get("beforeunload")!(event);
      return event;
    };
    expect(beforeUnload().preventDefault).not.toHaveBeenCalled();
    let finish!: (value: unknown) => void, reject!: (reason: unknown) => void;
    mocks.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    mocks.invoke.mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    const a = api.saveBatch({ id: "active", images: [] });
    const b = api.savePdf({ images: [], pageSize: "image", quality: 90 }, "test").catch(() => undefined);
    const pending = beforeUnload();
    expect(pending.preventDefault).toHaveBeenCalledOnce();
    expect(pending.returnValue).toBe("");
    finish({ ok: false, error: "CANCELED" }); await a;
    expect(beforeUnload().preventDefault).toHaveBeenCalledOnce();
    reject(new Error("renderer IPC disconnected")); await b;
    expect(beforeUnload().preventDefault).not.toHaveBeenCalled();
    expect(Object.isFrozen(api)).toBe(true);
  });
  it("keeps an explicit enhancement alive across attempted renderer reloads", async () => {
    const api = mocks.api as ClaruneAPI;
    let finish!: (value: unknown) => void;
    mocks.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = api.enhanceImage({ id: "single-ai", bytes: new Uint8Array(), upscale: { scale: 4, model: "realesrgan-x4plus", tileSize: 128 } });
    const event = { preventDefault: vi.fn(), returnValue: undefined as string | undefined };
    mocks.listeners.get("beforeunload")!(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    finish({ ok: false, error: "CANCELED", canceled: true }); await pending;
    event.preventDefault.mockClear();
    mocks.listeners.get("beforeunload")!(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
