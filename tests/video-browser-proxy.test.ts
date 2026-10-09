import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { PassThrough } from "node:stream";
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), connect: vi.fn() }));
vi.mock("../src/main/video-parser/public-dns", () => ({ publicLookup: mocks.lookup }));
vi.mock("node:net", async original => ({ ...await original<typeof import("node:net")>(), connect: mocks.connect }));
import { createBrowserProxy } from "../src/main/video-parser/browser-proxy";
const proxies: Awaited<ReturnType<typeof createBrowserProxy>>[] = [];
beforeEach(() => {
  mocks.lookup.mockReset().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  mocks.connect.mockReset().mockImplementation(() => {
    const socket = Object.assign(new PassThrough(), { setTimeout: () => {} });
    queueMicrotask(() => socket.emit("connect")); return socket;
  });
});
afterEach(async () => { for (const proxy of proxies.splice(0)) await proxy.close(); });
async function setup(signal = new AbortController().signal) { const proxy = await createBrowserProxy(signal); proxies.push(proxy); return proxy; }
function tunnel(proxy: Awaited<ReturnType<typeof createBrowserProxy>>, path: string, auth = true): Promise<number> {
  return new Promise(resolve => {
    const req = request({ host: "127.0.0.1", port: proxy.port, method: "CONNECT", path, headers: auth ? { "Proxy-Authorization": `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}` } : {} });
    req.setTimeout(1500, () => { req.destroy(); resolve(0); });
    req.on("connect", (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 0); });
    req.on("error", () => resolve(0)); req.end();
  });
}
describe("private authenticated browser tunnel", () => {
  it("requires its per-parse secret before any outgoing DNS/socket", async () => {
    const proxy = await setup(); expect(await tunnel(proxy, "www.douyin.com:443", false)).toBe(407);
    expect(mocks.lookup).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled();
  });
  it.each(["localhost:443", "127.0.0.1:443", "www.douyin.com:80", "www.douyin.com.evil.com:443", "v3.douyinvod.com:443"])("blocks unapproved CONNECT target %s", async path => {
    expect(await tunnel(await setup(), path)).toBe(0); expect(mocks.lookup).not.toHaveBeenCalled();
  });
  it("pins an approved connection to the validated public address", async () => {
    expect(await tunnel(await setup(), "www.douyin.com:443")).toBe(200);
    expect(mocks.connect).toHaveBeenCalledWith({ host: "8.8.8.8", family: 4, port: 443 });
  });
  it("rejects mixed private/public DNS instead of connecting", async () => {
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    expect(await tunnel(await setup(), "www.douyin.com:443")).toBe(0); expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("closes its listener on cancellation and closes idempotently", async () => {
    const abort = new AbortController(); const proxy = await setup(abort.signal); abort.abort(); await proxy.close();
    expect(await tunnel(proxy, "www.douyin.com:443")).toBe(0);
  });
});
