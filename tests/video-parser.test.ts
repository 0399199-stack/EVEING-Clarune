import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { extractShareLinks, normalizeShare, VideoFailure } from "../src/shared/video-parser";
import { navigationGroups, pageFromHash, pageRoute } from "../src/shared/navigation";
import { isPublicAddress, validateNetworkUrl, readText, checkStatus, type NetClient, type NetResponse } from "../src/main/video-parser/network";
import { createDouyinProvider, normalizeDetail } from "../src/main/video-parser/douyin-provider";

const id = "7675412388233414629";
const source = `https://www.douyin.com/video/${id}`;
export function response(body: string | Buffer, status = 200, headers: Record<string, string> = {}, url = source): NetResponse {
  const stream = Readable.from([Buffer.from(body)]);
  return { status, headers, url, body: stream, close: () => stream.destroy() };
}
export const detail = { aweme_id: id, desc: "Synthetic test only", author: { nickname: "Offline fixture" }, video: { play_addr: { uri: "fixture" }, width: 1280, height: 720, duration: 1200 } };
describe("Douyin input and navigation", () => {
  it("has exactly one nested destination and resolves direct child and parent", () => {
    expect(navigationGroups.filter(group => group.items.includes("douyin"))).toEqual([{ title: "videoParserGroup", items: ["douyin"], collapsible: true }]);
    expect(pageFromHash("#/video-parser/douyin")).toBe("douyin"); expect(pageFromHash("#/video-parser")).toBe("douyin");
    expect(pageRoute("douyin")).toBe("/video-parser/douyin"); expect(pageFromHash("#/settings")).toBe("settings");
  });
  it("extracts share prose, trims punctuation and deduplicates before counting", () => {
    expect(extractShareLinks(`复制链接 https://v.douyin.com/abcd/，\nhttps://v.douyin.com/abcd/。\n${source}）`)).toEqual(["https://v.douyin.com/abcd/", source]);
    expect(normalizeShare(`http://www.iesdouyin.com/share/slides/${id}/?foo=bar`)).toBe(`https://www.douyin.com/note/${id}`);
  });
  it.each(["", "没有链接", "https://douyin.com/user/test", "https://live.douyin.com/123", "https://douyin.com.evil.com/video/12345678", "https://user:pass@www.douyin.com/video/12345678", "https://127.0.0.1/video/12345678", "https://www.douyin.com:444/video/12345678", "javascript:alert(1)"])("rejects invalid or unsupported input %s", value => {
    expect(() => extractShareLinks(value)).toThrow(VideoFailure);
  });
  it("rejects more than 100 rather than silently truncating", () => {
    expect(() => extractShareLinks(Array.from({ length: 101 }, (_, i) => `https://www.douyin.com/video/${10000000 + i}`).join("\n"))).toThrow("TOO_MANY_LINKS");
  });
  it("accepts selected-work modal links and deduplicates their canonical form", () => {
    expect(normalizeShare(`https://www.douyin.com/jingxuan?modal_id=${id}`)).toBe(source);
    expect(normalizeShare(`https://www.douyin.com/?recommend=1&modal_id=${id}`)).toBe(source);
    expect(extractShareLinks(`${source}\nhttps://www.douyin.com/jingxuan?modal_id=${id}`)).toEqual([source]);
  });
  it.each([`https://www.douyin.com/jingxuan?modal_id=${id}&modal_id=12345678`, "https://www.douyin.com/jingxuan?modal_id=invalid", `https://www.douyin.com/user/example?modal_id=${id}`, `https://v.douyin.com/?modal_id=${id}`])("rejects ambiguous or unsupported modal links %s", value => {
    expect(() => normalizeShare(value)).toThrow("UNSUPPORTED_LINK");
  });
});
describe("network policy", () => {
  it.each(["127.0.0.1", "0.0.0.0", "10.1.1.1", "100.100.100.200", "169.254.169.254", "172.16.0.1", "192.168.1.1", "::1", "::ffff:127.0.0.1", "fe80::1", "fd00::1", "2001:db8::1", "224.0.0.1"])("blocks internal/reserved address %s", address => expect(isPublicAddress(address)).toBe(false));
  it("allows public DNS answers and reviewed media domains only", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true); expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
    expect(validateNetworkUrl("https://v3.douyinvod.com/file", "media").hostname).toBe("v3.douyinvod.com");
    for (const url of ["https://v3.douyinvod.com.evil.com/a", "https://127.0.0.1/a", "https://www.iesdouyin.com/arbitrary", "file:///a", "https://u:p@p3.douyinpic.com/a"]) expect(() => validateNetworkUrl(url, "media")).toThrow("BLOCKED_URL");
  });
  it("bounds page responses and honors rate-limit metadata", async () => {
    await expect(readText(response("abc"), 2)).rejects.toThrow("INVALID_DATA");
    try { checkStatus(response("", 429, { "retry-after": "120" })); } catch (error) { expect((error as VideoFailure).retryAfterMs).toBe(120000); }
    await expect(readText(response("denied", 403))).rejects.toThrow("ACCESS_DENIED");
  });
});
describe("pinned metadata-only provider", () => {
  it("follows short page to metadata without fetching media; preserves long numeric ID", async () => {
    const calls: string[] = [];
    const client: NetClient = async (url, options) => {
      calls.push(url); expect(options.scope).toBe("page");
      return url.includes("aweme/detail") ? response(JSON.stringify({ status_code: 0, aweme_detail: detail }).replace(`"${id}"`, id)) : response(`<script>window.x={"itemId":"${id}"}</script>`, 200, {}, "https://v.douyin.com/abcd/");
    };
    const result = await createDouyinProvider(client).parse("https://v.douyin.com/abcd/", new AbortController().signal);
    expect(result.contentId).toBe(id); expect(calls).toHaveLength(2); expect(result.assets[0].kind).toBe("video");
    expect(result.variants).toEqual([]); expect(result.capabilities.copyDirectLink).toBe(false);
  });
  it("keeps gallery order and offers only actual ancillary resources", () => {
    const result = normalizeDetail({ aweme_detail: { ...detail, video: undefined, images: [{ url_list: ["https://p3.douyinpic.com/a.png"] }, { download_url_list: ["https://p3.douyinpic.com/b.webp"] }] } }, id, source);
    expect(result.mediaType).toBe("gallery"); expect(result.assets.map(asset => [asset.kind, asset.order])).toEqual([["image", 1], ["image", 2]]);
    expect(result.cover).toBeNull(); expect(result.durationMs).toBeNull(); expect(result.assets[0].format).toBeNull();
  });
  it("does not silently omit missing images, invent dimensions, or trust rounded IDs", () => {
    expect(() => normalizeDetail({ aweme_detail: { ...detail, images: [{}] } }, id, source)).toThrow("INVALID_DATA");
    expect(() => normalizeDetail({ aweme_detail: { ...detail, aweme_id: Number(id) } }, id, source)).toThrow("INVALID_DATA");
    expect(() => normalizeDetail({ aweme_detail: { aweme_id: id } }, id, source)).toThrow("EMPTY_MEDIA");
    const result = normalizeDetail({ aweme_detail: { ...detail, video: { play_addr: { uri: "fixture" } } } }, id, source);
    expect(result.width).toBeNull(); expect(result.height).toBeNull();
  });
  it("keeps primary metadata when an optional cover violates the policy", () => {
    expect(normalizeDetail({ aweme_detail: { ...detail, video: { ...detail.video, cover: { url_list: ["https://localhost/secret"] } } } }, id, source).cover).toBeNull();
  });
  it("does not retry validation pages, denials or malformed metadata", async () => {
    const client = vi.fn<NetClient>(async () => response("<html>verify</html>"));
    await expect(createDouyinProvider(client).parse(source, new AbortController().signal)).rejects.toThrow("ENGINE_UNAVAILABLE");
    expect(client).toHaveBeenCalledTimes(1);
  });
  it("honors cancellation before metadata fetch", async () => {
    const abort = new AbortController(); const client = vi.fn<NetClient>(); abort.abort();
    await expect(createDouyinProvider(client).parse(source, abort.signal)).rejects.toThrow(); expect(client).not.toHaveBeenCalled();
  });
});
