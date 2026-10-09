import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), calls: [] as { url: string; headers: Record<string, string>; addresses?: unknown }[], responses: [] as { status: number; location?: string }[] }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: (url: URL, options: any, onResponse: (response: any) => void) => {
  const req = new EventEmitter() as EventEmitter & { end: () => void; setTimeout: () => void; destroy: (error?: Error) => void };
  const call = { url: url.href, headers: options.headers, addresses: undefined as unknown }; mocks.calls.push(call);
  req.setTimeout = () => {};
  req.destroy = error => { if (error) req.emit("error", error); };
  req.end = () => options.lookup(url.hostname, { all: true }, (error: Error | null, addresses: unknown) => {
    if (error) { req.emit("error", error); return; }
    call.addresses = addresses;
    const fixture = mocks.responses.shift() ?? { status: 200 };
    const body = Readable.from([Buffer.from("fixture")]);
    onResponse(Object.assign(body, { statusCode: fixture.status, headers: fixture.location ? { location: fixture.location } : {} }));
  });
  return req;
} }));
import { secureRequest } from "../src/main/video-parser/network";
beforeEach(() => {
  mocks.calls.length = 0; mocks.responses.length = 0;
  mocks.lookup.mockReset().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
});
describe("actual production transport policy with injected DNS/socket", () => {
  it("pins only reviewed DNS answers and strips caller credentials", async () => {
    const result = await secureRequest("https://p3.douyinpic.com/file", { scope: "media", signal: new AbortController().signal,
      headers: { Cookie: "never-forward", Authorization: "never-forward", Range: "bytes=0-15" } });
    result.close();
    expect(mocks.calls[0].addresses).toEqual([{ address: "8.8.8.8", family: 4 }]);
    expect(mocks.calls[0].headers.Cookie).toBeUndefined(); expect(mocks.calls[0].headers.Authorization).toBeUndefined();
    expect(mocks.calls[0].headers.Range).toBe("bytes=0-15");
    expect(mocks.calls[0].headers.Referer).toBe("https://www.douyin.com/");
    expect(mocks.calls[0].headers["User-Agent"]).toContain("Windows NT");
  });
  it("rejects a mixed public/private DNS answer before establishing the socket", async () => {
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "::ffff:127.0.0.1", family: 6 }]);
    await expect(secureRequest("https://p3.douyinpic.com/file", { scope: "media", signal: new AbortController().signal })).rejects.toThrow("BLOCKED_URL");
    expect(mocks.calls[0].addresses).toBeUndefined();
  });
  it("validates redirect destinations and repeats DNS pinning", async () => {
    mocks.responses.push({ status: 302, location: "https://p4.douyinpic.com/file" });
    mocks.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]).mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    await expect(secureRequest("https://p3.douyinpic.com/file", { scope: "media", signal: new AbortController().signal })).rejects.toThrow("BLOCKED_URL");
    expect(mocks.lookup).toHaveBeenCalledTimes(2); expect(mocks.calls[1].addresses).toBeUndefined();
  });
  it("blocks external or private redirects before DNS", async () => {
    mocks.responses.push({ status: 302, location: "http://localhost/secret" });
    await expect(secureRequest("https://v.douyin.com/abcd/", { scope: "page", signal: new AbortController().signal })).rejects.toThrow("BLOCKED_URL");
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });
  it("bounds redirect loops", async () => {
    mocks.responses.push(...Array.from({ length: 6 }, () => ({ status: 302, location: "https://p3.douyinpic.com/file" })));
    await expect(secureRequest("https://p3.douyinpic.com/file", { scope: "media", signal: new AbortController().signal })).rejects.toThrow("BLOCKED_URL");
    expect(mocks.calls).toHaveLength(6);
  });
});
