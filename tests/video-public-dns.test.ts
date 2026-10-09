import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), requests: [] as string[], status: 200, body: "", error: false }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: (url: string, options: any, respond: (res: any) => void) => {
  mocks.requests.push(url);
  const req = new EventEmitter() as any;
  req.destroy = (error: Error) => { req.emit("error", error); req.emit("close"); };
  req.end = () => {
    if (mocks.error) { req.destroy(new Error("offline")); return; }
    const res = Object.assign(Readable.from([Buffer.from(mocks.body)]), { statusCode: mocks.status });
    res.on("close", () => req.emit("close")); respond(res);
    options.signal.addEventListener("abort", () => { res.destroy(); req.destroy(new DOMException("cancelled", "AbortError")); }, { once: true });
  };
  return req;
} }));
import { publicLookup } from "../src/main/video-parser/public-dns";
import { isPublicAddress } from "../src/main/video-parser/network";

beforeEach(() => {
  mocks.lookup.mockReset().mockResolvedValue([{ address: "198.18.0.97", family: 4 }]);
  mocks.requests.length = 0; mocks.status = 200; mocks.error = false;
  mocks.body = JSON.stringify({ Status: 0, Answer: [{ type: 5, data: "cdn.example" }, { type: 1, data: "8.8.8.8" }] });
});
describe("Fake-IP compatibility without permitting private media sockets", () => {
  it("sends only the allowlisted hostname to the fixed HTTPS DNS resolver", async () => {
    expect(await publicLookup("www.douyin.com", new AbortController().signal)).toEqual([{ address: "8.8.8.8", family: 4 }]);
    expect(mocks.requests).toEqual(["https://dns.alidns.com/resolve?name=www.douyin.com&type=A"]);
  });
  it.each(["8.8.8.8", "127.0.0.1", "169.254.169.254", "::1"])("never replaces ordinary public or prohibited local answers: %s", async address => {
    const original = [{ address, family: address.includes(":") ? 6 : 4 }]; mocks.lookup.mockResolvedValue(original);
    expect(await publicLookup("www.douyin.com", new AbortController().signal)).toEqual(original);
    expect(mocks.requests).toHaveLength(0);
  });
  it("does not disguise mixed Fake-IP/private answers", async () => {
    const mixed = [{ address: "198.18.0.97", family: 4 }, { address: "127.0.0.1", family: 4 }]; mocks.lookup.mockResolvedValue(mixed);
    expect(await publicLookup("www.douyin.com", new AbortController().signal)).toEqual(mixed);
    expect(mocks.requests).toHaveLength(0);
  });
  it("keeps private and malformed resolver answers subject to socket policy", async () => {
    mocks.body = JSON.stringify({ Status: 0, Answer: [{ type: 1, data: "127.0.0.1" }, { type: 1, data: "invalid" }] });
    const answers = await publicLookup("www.douyin.com", new AbortController().signal);
    expect(answers.every(item => isPublicAddress(item.address))).toBe(false);
  });
  it.each(["not json", "null", '{"Status":3}', '{"Status":0,"Answer":{}}'])("rejects invalid resolver data", async body => {
    mocks.body = body; await expect(publicLookup("www.douyin.com", new AbortController().signal)).rejects.toThrow();
  });
  it("does not follow resolver redirects", async () => {
    mocks.status = 302; await expect(publicLookup("www.douyin.com", new AbortController().signal)).rejects.toThrow("NETWORK");
    expect(mocks.requests).toHaveLength(1);
  });
  it("bounds resolver response size", async () => {
    mocks.body = "x".repeat(65537); await expect(publicLookup("www.douyin.com", new AbortController().signal)).rejects.toThrow("INVALID_DATA");
  });
  it("honors cancellation before DNS", async () => {
    const abort = new AbortController(); abort.abort();
    await expect(publicLookup("www.douyin.com", abort.signal)).rejects.toThrow();
    expect(mocks.lookup).not.toHaveBeenCalled(); expect(mocks.requests).toHaveLength(0);
  });
});
