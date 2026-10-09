import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ windows: [] as any[], options: [] as any[], read: vi.fn(), clear: vi.fn(), connections: vi.fn(), closeProxy: vi.fn(), partition: vi.fn() }));
vi.mock("../src/main/video-parser/browser-proxy", () => ({ createBrowserProxy: async () => ({ port: 12345, username: "test", password: "test", close: state.closeProxy }) }));
vi.mock("electron", () => ({
  session: { fromPartition: state.partition },
  BrowserWindow: class extends EventEmitter {
    dead = false;
    webContents = Object.assign(new EventEmitter(), { setAudioMuted() {}, setWebRTCIPHandlingPolicy() {}, setWindowOpenHandler() {}, executeJavaScript: state.read });
    constructor(options: unknown) { super(); state.windows.push(this); state.options.push(options); }
    removeMenu() {} show() {} loadURL() { return Promise.resolve(); }
    isDestroyed() { return this.dead; }
    destroy() { this.dead = true; this.emit("closed"); }
  },
}));
import { readPublicDouyinPage } from "../src/main/video-parser/browser-reader";
beforeEach(() => {
  state.windows.length = 0; state.options.length = 0;
  state.read.mockReset(); state.clear.mockReset().mockResolvedValue(undefined); state.connections.mockReset().mockResolvedValue(undefined); state.closeProxy.mockReset().mockResolvedValue(undefined);
  state.partition.mockReset().mockReturnValue({ setProxy: async () => {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {}, webRequest: { onBeforeRequest() {} }, clearStorageData: state.clear, closeAllConnections: state.connections });
});
it("finishes cancellation even if Chromium never resolves its initial script evaluation", async () => {
  state.read.mockImplementation(() => new Promise(() => {}));
  const abort = new AbortController(); const work = readPublicDouyinPage("7667114943409311017", abort.signal);
  const rejected = expect(work).rejects.toThrow("CANCELLED");
  await vi.waitFor(() => expect(state.read).toHaveBeenCalled()); abort.abort();
  await rejected;
  expect(state.windows[0].dead).toBe(true); expect(state.closeProxy).toHaveBeenCalled(); expect(state.clear).toHaveBeenCalled();
});
it("closing the verification window cancels a pending read and releases its temporary session", async () => {
  state.read.mockImplementation(() => new Promise(() => {}));
  const work = readPublicDouyinPage("7667114943409311017", new AbortController().signal);
  const rejected = expect(work).rejects.toThrow("CANCELLED");
  await vi.waitFor(() => expect(state.read).toHaveBeenCalled()); state.windows[0].destroy(); await rejected;
  expect(state.connections).toHaveBeenCalled(); expect(state.closeProxy).toHaveBeenCalled(); expect(state.clear).toHaveBeenCalled();
});
it("uses an isolated nonpersistent sandbox without a preload bridge", async () => {
  state.read.mockResolvedValue("fixture");
  expect(await readPublicDouyinPage("7667114943409311017", new AbortController().signal)).toBe("fixture");
  expect(state.partition.mock.calls[0][0]).toMatch(/^clarune-douyin-/);
  expect(state.options[0].webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false });
  expect(state.options[0].webPreferences.preload).toBeUndefined(); expect(state.clear).toHaveBeenCalled();
});
