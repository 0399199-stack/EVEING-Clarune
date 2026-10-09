import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { downloadFile, mediaFormat, publishMedia, rangePlan, safeFilename, type TransferState } from "../src/main/video-parser/transfer";
import type { NetClient, NetResponse } from "../src/main/video-parser/network";

const folders: string[] = [];
afterEach(async () => { for (const path of folders.splice(0)) await rm(path, { recursive: true, force: true }); });
function box(name: string, body: string) { const buffer = Buffer.alloc(8 + body.length); buffer.writeUInt32BE(buffer.length); buffer.write(name, 4); buffer.write(body, 8); return buffer; }
const mp4 = Buffer.concat([box("ftyp", "isom0000"), box("moov", "fixture"), box("mdat", "synthetic test data only")]);
const url = "https://v3.douyinvod.com/fixture";
function response(body: Buffer | string, status = 200, headers: Record<string, string> = {}): NetResponse {
  const stream = Readable.from([Buffer.from(body)]);
  return { body: stream, close: () => stream.destroy(), url, status, headers };
}
async function setup() { const dir = await mkdtemp(join(tmpdir(), "clarune-transfer-")); folders.push(dir); return { dir, part: join(dir, "task.part") }; }
const fresh = (): TransferState => ({ bytes: 0, total: null });
describe("safe media transfer", () => {
  it("streams, reports actual bytes, validates and publishes without overwriting", async () => {
    const { dir, part } = await setup(); const state = fresh(); const progress = vi.fn();
    const result = await downloadFile({ url, part, state, kind: "video", signal: new AbortController().signal, progress,
      client: async () => response(mp4, 200, { "content-length": String(mp4.length) }) });
    expect(result.extension).toBe("mp4"); expect(state.bytes).toBe(mp4.length); expect(progress).toHaveBeenCalled();
    await writeFile(join(dir, "作品.mp4"), "original");
    const saved = await publishMedia(part, dir, "作品", "mp4");
    expect(saved).toBe(join(dir, "作品 (1).mp4")); expect(await readFile(saved)).toEqual(mp4);
    expect(await readFile(join(dir, "作品.mp4"), "utf8")).toBe("original"); expect(await readdir(dir)).not.toContain("task.part");
  });
  it("resumes only matching strong ETag and exact 206 byte range", async () => {
    const { part } = await setup(); await writeFile(part, mp4.subarray(0, 16));
    const state = { bytes: 16, total: mp4.length, etag: '"fixture-v1"' };
    const client: NetClient = async (_url, options) => {
      expect(options.headers).toEqual({ Range: "bytes=16-", "If-Range": '"fixture-v1"' });
      return response(mp4.subarray(16), 206, { etag: '"fixture-v1"', "content-range": `bytes 16-${mp4.length - 1}/${mp4.length}`, "content-length": String(mp4.length - 16) });
    };
    await downloadFile({ url, part, state, kind: "video", signal: new AbortController().signal, progress: () => {}, client });
    expect(await readFile(part)).toEqual(mp4);
  });
  it("restarts instead of appending when Range gets a 200 response", async () => {
    const { part } = await setup(); await writeFile(part, "old bytes");
    await downloadFile({ url, part, state: { bytes: 9, total: 999, etag: '"old"' }, kind: "video", signal: new AbortController().signal, progress: () => {}, client: async () => response(mp4, 200, { "content-length": String(mp4.length) }) });
    expect(await readFile(part)).toEqual(mp4);
  });
  it("never treats 416 as completed; makes one fresh request", async () => {
    const { part } = await setup(); await writeFile(part, "incomplete");
    const client = vi.fn<NetClient>().mockResolvedValueOnce(response("", 416)).mockResolvedValueOnce(response(mp4));
    await downloadFile({ url, part, state: { bytes: 10, total: 10, etag: '"bad"' }, kind: "video", signal: new AbortController().signal, progress: () => {}, client });
    expect(client).toHaveBeenCalledTimes(2); expect(client.mock.calls[1][1].headers).toEqual({}); expect(await readFile(part)).toEqual(mp4);
  });
  it.each([
    { range: "bytes 15-49/50", etag: '"same"' },
    { range: "bytes 16-49/50", etag: '"different"' },
    { range: "bytes 16-59/60", etag: '"same"' },
    { range: "bytes 16-50/50", etag: '"same"' },
  ])("rejects mismatched partial response %o", ({ range, etag }) => {
    expect(() => rangePlan(response("", 206, { "content-range": range, etag }), { bytes: 16, total: 50, etag: '"same"' })).toThrow("RANGE_MISMATCH");
  });
  it("rejects HTML/JSON even with status 200 and no Content-Type", async () => {
    for (const body of ["<html>verification page</html>", '{"error":"please login"}']) {
      const { part } = await setup(); const client = vi.fn<NetClient>(async () => response(body));
      await expect(downloadFile({ url, part, state: fresh(), kind: "video", signal: new AbortController().signal, progress: () => {}, client })).rejects.toThrow("INVALID_MEDIA");
      expect(client).toHaveBeenCalledTimes(1);
    }
  });
  it("rejects empty bodies and incomplete containers", async () => {
    const { part } = await setup();
    await expect(downloadFile({ url, part, state: fresh(), kind: "video", signal: new AbortController().signal, progress: () => {}, client: async () => response("") })).rejects.toThrow("EMPTY_MEDIA");
    const malformed = Buffer.concat([box("ftyp", "isom0000"), box("free", "not a complete video")]);
    await expect(downloadFile({ url, part, state: fresh(), kind: "video", signal: new AbortController().signal, progress: () => {}, client: async () => response(malformed) })).rejects.toThrow("INVALID_MEDIA");
  });
  it("detects truncated lengths with bounded retries", async () => {
    const { part } = await setup(); const client = vi.fn<NetClient>(async () => response(mp4, 200, { "content-length": String(mp4.length + 1) }));
    await expect(downloadFile({ url, part, state: fresh(), kind: "video", signal: new AbortController().signal, progress: () => {}, client })).rejects.toThrow("TRUNCATED");
    expect(client).toHaveBeenCalledTimes(3);
  });
  it("handles abort without publishing the temporary file", async () => {
    const { part } = await setup(); const abort = new AbortController();
    const client: NetClient = async () => {
      const stream = Readable.from((async function* () { yield mp4.subarray(0, 20); abort.abort(); abort.signal.throwIfAborted(); })());
      return { url, status: 200, headers: {}, body: stream, close: () => stream.destroy() };
    };
    await expect(downloadFile({ url, part, state: fresh(), kind: "video", signal: abort.signal, progress: () => {}, client })).rejects.toThrow("CANCELLED");
    expect((await stat(part)).size).toBeLessThan(mp4.length);
  });
  it("uses content formats and cleans Windows reserved names and traversal", () => {
    expect(safeFilename("../../CON")).not.toMatch(/[\/\\]/); expect(safeFilename("CON.txt")).toBe("_CON.txt");
    expect(safeFilename("  ")).toBe("douyin"); expect(safeFilename("a".repeat(200))).toHaveLength(70);
    expect(mediaFormat(Buffer.from("ID3test synthetic"), "audio").extension).toBe("mp3");
    expect(() => mediaFormat(mp4, "image")).toThrow("INVALID_MEDIA");
  });
});
