import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import { VideoService } from "../src/main/video-parser/service";
import { normalizeDetail, type DouyinProvider } from "../src/main/video-parser/douyin-provider";
import { delay, type NetClient, type NetResponse } from "../src/main/video-parser/network";
import { VideoFailure } from "../src/shared/video-parser";

const folders: string[] = []; const services: VideoService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.shutdown(); for (const path of folders.splice(0)) await rm(path, { recursive: true, force: true }); });
const id = "7675412388233414629"; const source = `https://www.douyin.com/note/${id}`;
const gallery = normalizeDetail({ aweme_detail: { aweme_id: id, desc: "测试图集", author: { nickname: "Offline test" }, images: [{ url_list: ["https://p3.douyinpic.com/1?secret-signature=test-only"] }, { url_list: ["https://p3.douyinpic.com/2"] }] } }, id, source);
function response(body: Buffer | string, status = 200, headers: Record<string, string> = {}): NetResponse {
  const stream = Readable.from([Buffer.from(body)]);
  return { body: stream, close: () => stream.destroy(), url: "https://p3.douyinpic.com/1", status, headers };
}
async function setup(extra: Partial<ConstructorParameters<typeof VideoService>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "clarune-service-")); folders.push(dir);
  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "white" } }).png().toBuffer();
  const client = vi.fn<NetClient>(async () => response(png, 200, { "content-length": String(png.length) }));
  const provider: DouyinProvider = { parse: vi.fn(async () => structuredClone(gallery)) };
  const options = { storagePath: join(dir, "state.json"), defaultDirectory: join(dir, "中文 保存路径"), provider, client, engineAvailable: true, parseIntervalMs: 0, ...extra };
  const service = new VideoService(options); services.push(service);
  return { dir, png, client, provider, service, options };
}
async function parsed(service: VideoService) { return (await service.parse(randomUUID(), source))[0].result!; }
async function settled(service: VideoService, state: string) {
  await vi.waitFor(async () => expect((await service.snapshot()).tasks[0]?.state).toBe(state), { timeout: 3000, interval: 10 });
  return (await service.snapshot()).tasks[0];
}
describe("parse sessions, queue and persistence", () => {
  it("parsing does not download or create media files; only public metadata crosses IPC", async () => {
    const { service, client, dir } = await setup(); const result = await parsed(service);
    expect(client).not.toHaveBeenCalled(); expect((await service.snapshot()).tasks).toEqual([]);
    expect(await readdir(dir)).toEqual(["state.json"]); expect(JSON.stringify(result)).not.toContain("secret-signature");
    const disk = await readFile(join(dir, "state.json"), "utf8"); expect(disk).not.toContain("secret-signature"); expect(disk).not.toContain("douyinpic.com");
  });
  it("deduplicates complete content IDs after parsing", async () => {
    const { service } = await setup();
    const items = await service.parse(randomUUID(), `${source}\nhttps://v.douyin.com/abcd/`);
    expect(items[1].duplicate).toBe(true); expect(items.filter(item => item.result)).toHaveLength(1);
  });
  it("an invalid batch item does not block other valid items or enter history with unsafe credentials", async () => {
    const { service, provider } = await setup();
    const results = await service.parse(randomUUID(), `https://secret:password@www.douyin.com/video/${id}\n${source}`);
    expect(results[0]).toEqual({ sourceUrl: "", state: "failed", error: "BLOCKED_URL" });
    expect(results[1].state).toBe("succeeded"); expect(provider.parse).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await service.snapshot())).not.toContain("password");
  });
  it("a cancelled old parse cannot return successful sessions over a newer parse", async () => {
    const provider: DouyinProvider = { parse: vi.fn(async (_source, signal) => { await delay(50, signal); return structuredClone(gallery); }) };
    const { service } = await setup({ provider });
    const first = service.parse(randomUUID(), source).catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 10));
    const second = service.parse(randomUUID(), source);
    expect((await first).code).toBe("CANCELLED"); expect((await second)[0].state).toBe("succeeded");
  });
  it("fails independently and enforces the packaged unavailable gate", async () => {
    const { service, provider } = await setup({ engineAvailable: false });
    expect((await service.parse(randomUUID(), source))[0].error).toBe("ENGINE_UNAVAILABLE"); expect(provider.parse).not.toHaveBeenCalled();
    expect((await service.snapshot()).tasks).toEqual([]);
  });
  it("saves a gallery in original order; clearing history never deletes files", async () => {
    const { service, png } = await setup(); const result = await parsed(service);
    await service.enqueue(result.sessionId, "image");
    const task = await settled(service, "completed"); expect(task.completed).toBe(2);
    expect(task.paths[0]).toContain(`001_${id}.png`); expect(task.paths[1]).toContain(`002_${id}.png`);
    await service.clearHistory(); expect((await service.snapshot()).history).toEqual([]);
    expect(await readFile(task.paths[0])).toEqual(png);
    await unlink(task.paths[0]); await expect(service.outputPath(task.id)).rejects.toThrow("MISSING_FILE");
  });
  it("partial galleries are failed, and retry downloads only missing items", async () => {
    const { service, client, png } = await setup();
    client.mockResolvedValueOnce(response(png)).mockResolvedValueOnce(response("<html>invalid file</html>"));
    await service.enqueue((await parsed(service)).sessionId, "image");
    const failed = await settled(service, "failed"); expect(failed.completed).toBe(1); expect(failed.paths).toHaveLength(1);
    await service.taskAction(failed.id, "retry"); const completed = await settled(service, "completed");
    expect(client).toHaveBeenCalledTimes(3); expect(completed.paths[0]).toBe(failed.paths[0]);
  });
  it("pauses and resumes a real stream safely; cancel removes only its own partial", async () => {
    const { service, client, png } = await setup(); let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    client.mockImplementationOnce(async (_url, options) => {
      const stream = Readable.from((async function* () { yield png.subarray(0, 32); started(); await delay(60_000, options.signal); yield png.subarray(32); })());
      return { status: 200, url: "https://p3.douyinpic.com/1", headers: {}, body: stream, close: () => stream.destroy() };
    });
    const task = await service.enqueue((await parsed(service)).sessionId, "image"); await entered;
    await service.taskAction(task.id, "pause"); expect((await service.snapshot()).tasks[0].state).toBe("paused");
    await service.taskAction(task.id, "resume"); const saved = await settled(service, "completed"); expect(saved.completed).toBe(2);
    expect(await readFile(saved.paths[0])).toEqual(png);
  });
  it("cancel removes its own partial and retains unrelated files", async () => {
    const { service, client, png } = await setup(); let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    client.mockImplementationOnce(async (_url, options) => {
      const stream = Readable.from((async function* () { yield png.subarray(0, 32); started(); await delay(60_000, options.signal); })());
      return { status: 200, url: "https://p3.douyinpic.com/1", headers: {}, body: stream, close: () => stream.destroy() };
    });
    const task = await service.enqueue((await parsed(service)).sessionId, "image"); await entered;
    const root = (await service.snapshot()).directory;
    const galleryDir = join(root, (await readdir(root))[0]);
    const unrelated = join(galleryDir, "original.txt"); await writeFile(unrelated, "keep");
    await service.taskAction(task.id, "cancel");
    expect((await service.snapshot()).tasks[0].state).toBe("cancelled");
    expect(await readdir(galleryDir)).toEqual(["original.txt"]); expect(await readFile(unrelated, "utf8")).toBe("keep");
  });
  it("re-parses expired media once and never appends new resource bytes to old bytes", async () => {
    const { service, client, provider, png } = await setup();
    client.mockResolvedValueOnce(response("denied", 403));
    await service.enqueue((await parsed(service)).sessionId, "image");
    const task = await settled(service, "completed");
    expect(provider.parse).toHaveBeenCalledTimes(2); expect(client).toHaveBeenCalledTimes(3); expect(await readFile(task.paths[0])).toEqual(png);
  });
  it("respects rate limiting before starting subsequent queued transfers", async () => {
    const { service, client } = await setup();
    client.mockResolvedValueOnce(response("", 429, { "retry-after": "120" }));
    const result = await parsed(service); await service.enqueue(result.sessionId, "image"); const task = await settled(service, "failed");
    expect(task.error).toBe("RATE_LIMIT");
    await service.taskAction(task.id, "retry");
    await new Promise(resolve => setTimeout(resolve, 25));
    expect((await service.snapshot()).tasks[0].state).toBe("queued"); expect(client).toHaveBeenCalledTimes(1);
  });
  it("serializes duplicate enqueue requests", async () => {
    const { service } = await setup(); const result = await parsed(service);
    const [a, b] = await Promise.all([service.enqueue(result.sessionId, "image"), service.enqueue(result.sessionId, "image")]);
    expect(a.id).toBe(b.id); expect((await service.snapshot()).tasks).toHaveLength(1); await settled(service, "completed");
  });
  it("restores unfinished tasks paused, never persists media URLs, reparses before resume", async () => {
    const { service, client, options } = await setup(); let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
    client.mockImplementationOnce(async (_url, config) => { started(); await delay(60_000, config.signal); throw new Error("unreachable"); });
    const task = await service.enqueue((await parsed(service)).sessionId, "image"); await entered; await service.shutdown();
    const disk = await readFile(options.storagePath, "utf8"); expect(disk).not.toContain("secret-signature");
    const restored = new VideoService(options); services.push(restored);
    expect((await restored.snapshot()).tasks[0].state).toBe("paused"); expect(client).toHaveBeenCalledTimes(1);
    await restored.taskAction(task.id, "resume"); await settled(restored, "completed"); expect(options.provider.parse).toHaveBeenCalledTimes(2);
  });
  it("enforces license before adding a task and rejects arbitrary session IDs", async () => {
    const { service, client } = await setup({ requireLicense: async () => { throw new VideoFailure("LICENSE_REQUIRED"); } });
    await expect(service.enqueue("https://evil.example/", "video")).rejects.toThrow("SESSION_EXPIRED");
    await expect(service.enqueue((await parsed(service)).sessionId, "image")).rejects.toThrow("LICENSE_REQUIRED");
    expect(client).not.toHaveBeenCalled(); expect((await service.snapshot()).tasks).toHaveLength(0);
  });
  it("previews only registered capabilities, supports Range, and revokes on release", async () => {
    const { service, png } = await setup(); const result = await parsed(service);
    const url = service.preview(result.sessionId, "image-1");
    const preview = await service.previewResponse(new Request(url)); expect(preview.status).toBe(200); expect(Buffer.from(await preview.arrayBuffer())).toEqual(png);
    expect((await service.previewResponse(new Request("clarune-media://preview/arbitrary"))).status).toBe(404);
    service.release([result.sessionId]); expect((await service.previewResponse(new Request(url))).status).toBe(404);
  });
  it("forwards a single validated preview range and does not revoke newer sessions", async () => {
    const { service, client, png } = await setup(); const previous = await parsed(service); const result = await parsed(service);
    const url = service.preview(result.sessionId, "image-1"); service.release([previous.sessionId]);
    client.mockResolvedValueOnce(response(png.subarray(16), 206, { "content-type": "image/png", "content-range": `bytes 16-${png.length - 1}/${png.length}`, "content-length": String(png.length - 16) }));
    const reply = await service.previewResponse(new Request(url, { headers: { Range: "bytes=16-" } }));
    expect(reply.status).toBe(206); expect(Buffer.from(await reply.arrayBuffer())).toEqual(png.subarray(16));
    expect(client.mock.calls[0][1].headers).toEqual({ Range: "bytes=16-" });
  });
  it("rejects out-of-range parallelism", async () => {
    const { service } = await setup(); await expect(service.setConcurrency(4)).rejects.toThrow("INVALID_INPUT");
    await service.setConcurrency(1); expect((await service.snapshot()).concurrency).toBe(1);
  });
});
