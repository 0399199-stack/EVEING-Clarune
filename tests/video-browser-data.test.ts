import { describe, expect, it } from "vitest";
import { normalizeBrowserData } from "../src/main/video-parser/browser-data";
import { browserHostAllowed, browserRequestAllowed } from "../src/main/video-parser/browser-policy";
const id = "7667114943409311017";
const source = `https://www.douyin.com/video/${id}`;
const detail = { awemeId: id, desc: "Offline browser fixture", authorInfo: { nickname: "Fixture" }, isPrivate: false, status: { privateStatus: 0 },
  video: { width: 1920, height: 1080, duration: 10000, playAddr: [{ src: "//v3.douyinvod.com/video" }], coverUrlList: ["https://p3.douyinpic.com/cover"] },
};
const encode = (value: unknown) => encodeURIComponent(JSON.stringify({ app: { videoDetail: value } }));
describe("public browser metadata", () => {
  it("uses the exact requested post and actual playback metadata", () => {
    const result = normalizeBrowserData(encode(detail), id, source);
    expect(result.contentId).toBe(id); expect(result.authorName).toBe("Fixture"); expect(result.durationMs).toBe(10000);
    expect(result.assets[0].url).toBe("https://v3.douyinvod.com/video"); expect(result.cover?.kind).toBe("cover");
    expect(result.variants).toEqual([]); expect(result.assets.some(a => a.kind === "audio")).toBe(false);
  });
  it("rejects another post or rounded identifiers", () => {
    expect(() => normalizeBrowserData(encode({ ...detail, awemeId: "123456789" }), id, source)).toThrow("NOT_FOUND");
    expect(() => normalizeBrowserData(encode({ ...detail, awemeId: Number(id) }), id, source)).toThrow("NOT_FOUND");
  });
  it.each([{ isPrivate: true }, { isFriendLimit: true }, { status: { privateStatus: 1 } }, { status: { isDelete: true } }, { status: { isProhibited: true } }])("rejects nonpublic content %j", flags => {
    expect(() => normalizeBrowserData(encode({ ...detail, ...flags }), id, source)).toThrow("ACCESS_DENIED");
  });
  it.each(["%zz", "%7B", "x".repeat(4194305)])("rejects malformed or oversized metadata", value => {
    expect(() => normalizeBrowserData(value, id, source)).toThrow("INVALID_DATA");
  });
  it("does not accept local/external playback targets", () => {
    expect(() => normalizeBrowserData(encode({ ...detail, video: { playAddr: [{ src: "https://localhost/private" }] } }), id, source)).toThrow("BLOCKED_URL");
  });
  it("maps ordered gallery metadata without claiming live verification", () => {
    const result = normalizeBrowserData(encode({ ...detail, images: [{ urlList: ["https://p3.douyinpic.com/1"] }, { urlList: ["https://p3.douyinpic.com/2"] }] }), id, source);
    expect(result.mediaType).toBe("gallery"); expect(result.assets.filter(a => a.kind === "image").map(a => a.order)).toEqual([1, 2]);
  });
});
describe("isolated browser request boundary", () => {
  it("allows only reviewed page and verification resources", () => {
    expect(browserRequestAllowed(`https://www.douyin.com/jingxuan?modal_id=${id}`, "mainFrame", "GET")).toBe(true);
    expect(browserRequestAllowed("https://lf-rc1.yhgfb-cn-static.com/verification", "subFrame", "GET")).toBe(true);
    expect(browserHostAllowed("127.0.0.1")).toBe(false); expect(browserHostAllowed("www.douyin.com.evil.test")).toBe(false);
  });
  it.each(["https://v3.douyinvod.com/video", "https://www.douyin.com/aweme/v1/play/", "https://www.douyin.com/collect/", "https://www.douyin.com/video.mp4", "https://localhost/", "file:///secret", "https://user:pass@www.douyin.com/", "https://www.douyin.com:444/"])("blocks media and unsafe destinations %s", value => {
    expect(browserRequestAllowed(value, "xhr", "GET")).toBe(false);
  });
  it.each(["media", "ping", "webSocket"])("blocks %s even on a reviewed host", type => {
    expect(browserRequestAllowed("https://www.douyin.com/", type, "GET")).toBe(false);
  });
  it("blocks social/account writes and permits only verification POST hosts", () => {
    expect(browserRequestAllowed("https://www.douyin.com/aweme/v1/web/commit/item/digg/", "xhr", "POST")).toBe(false);
    expect(browserRequestAllowed("https://mssdk.bytedance.com/verify", "xhr", "POST")).toBe(true);
  });
});
