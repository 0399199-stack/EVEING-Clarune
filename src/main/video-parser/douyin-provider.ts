// Adapted from pwh-pwh/douyinVd/douyin.ts, MIT © 2025 coderpwh.
// Pinned upstream: 6b8530817c0eb98217f37f291717abc6828f4a6b.
// Changes: validated injectable transport, bounded metadata, cancellation, strict
// identifiers, no logging/automatic retries, explicit resources and no download.
// Full license: licenses/douyinVd/LICENSE.
import { contentIdFromUrl, normalizeShare, VideoFailure, type MediaAsset, type ParsedVideo } from "../../shared/video-parser";
import { readText, validateNetworkUrl, type NetClient } from "./network";

export const DOUYIN_ENGINE = { id: "douyinVd-clarune", version: "6b8530817c0eb98217f37f291717abc6828f4a6b-browser1", verifiedMedia: { video: true, gallery: false } } as const;
export interface PrivateAsset extends MediaAsset { url: string }
export interface ProviderResult extends Omit<ParsedVideo, "sessionId" | "assets" | "cover"> { assets: PrivateAsset[]; cover: PrivateAsset | null }
export interface DouyinProvider { parse: (source: string, signal: AbortSignal) => Promise<ProviderResult>; timeoutMs?: number }
type ObjectData = Record<string, unknown>;
const object = (value: unknown): ObjectData => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectData : {};
const str = (value: unknown, max = 2000): string => typeof value === "string" ? value.slice(0, max) : "";
const dimension = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
function urls(value: unknown): string[] { return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length <= 8192) : []; }
function firstUrl(value: unknown): string | null { const data = object(value); return urls(data.url_list ?? data.urlList)[0] ?? null; }
function parseJson(text: string): ObjectData {
  try {
    // Preserve long numeric IDs before JSON.parse can round them.
    return object(JSON.parse(text.replace(/("(?:aweme_id|itemId)"\s*:\s*)(\d{8,30})(?=\s*[,}])/g, '$1"$2"')));
  } catch { throw new VideoFailure("ENGINE_UNAVAILABLE"); }
}

export function normalizeDetail(payload: unknown, id: string, source: string): ProviderResult {
  const root = object(payload);
  if (root.status_code !== undefined && root.status_code !== 0) throw new VideoFailure("ACCESS_DENIED");
  const detail = object(root.aweme_detail);
  if (!Object.keys(detail).length) throw new VideoFailure("NOT_FOUND");
  if (typeof detail.aweme_id !== "string" || !/^\d{8,30}$/.test(detail.aweme_id) || detail.aweme_id !== id) throw new VideoFailure("INVALID_DATA");
  const video = object(detail.video);
  const assets: PrivateAsset[] = [];
  const add = (kind: MediaAsset["kind"], url: string, order: number, meta: ObjectData = {}): PrivateAsset => {
    const validated = validateNetworkUrl(url, "media");
    const asset: PrivateAsset = { resourceId: `${kind}-${order}`, kind, order, url: validated.href, format: null, width: dimension(meta.width), height: dimension(meta.height), size: dimension(meta.data_size) };
    assets.push(asset); return asset;
  };
  const images = detail.images;
  const gallery = Array.isArray(images) && images.length > 0;
  if (gallery) {
    if (images.length > 100) throw new VideoFailure("INVALID_DATA");
    images.forEach((item, index) => {
      const data = object(item);
      const list = urls(data.download_url_list).length ? urls(data.download_url_list) : urls(data.url_list);
      const url = list.find(value => { try { return !new URL(value).pathname.includes("/obj/"); } catch { return false; } });
      if (!url) throw new VideoFailure("INVALID_DATA");
      add("image", url, index + 1, data);
    });
  } else {
    const play = object(video.play_addr);
    const uri = str(play.uri, 256);
    // This is the upstream playback endpoint, not a fetched video body or a quality claim.
    const url = /^[a-zA-Z0-9_-]+$/.test(uri) ? `https://www.iesdouyin.com/aweme/v1/play/?video_id=${encodeURIComponent(uri)}&line=0` : firstUrl(play)?.replace(/\/playwm\//, "/play/");
    if (!url) throw new VideoFailure("EMPTY_MEDIA");
    add("video", url, 1, video);
  }
  const coverUrl = firstUrl(video.cover);
  let cover: PrivateAsset | null = null;
  if (coverUrl) {
    try { cover = add("cover", coverUrl, 1, object(video.cover)); } catch { /* Optional media must not discard the main result. */ }
  }
  const musicUrl = firstUrl(object(detail.music).play_url);
  if (musicUrl) {
    try { add("audio", musicUrl, 1); } catch { /* Do not offer a resource outside the reviewed CDN policy. */ }
  }
  return {
    platform: "douyin", contentId: id, sourceUrl: source,
    canonicalUrl: `https://www.douyin.com/${gallery ? "note" : "video"}/${id}`,
    mediaType: gallery ? "gallery" : "video", title: str(detail.desc), authorName: str(object(detail.author).nickname, 200),
    durationMs: gallery ? null : dimension(video.duration), width: gallery ? null : dimension(video.width), height: gallery ? null : dimension(video.height),
    assets, cover, variants: [], capabilities: { preview: true, download: true, copyDirectLink: false },
    engineId: DOUYIN_ENGINE.id, engineVersion: DOUYIN_ENGINE.version, parsedAt: new Date().toISOString(),
  };
}

export function createDouyinProvider(client: NetClient, publicPage?: (id: string, source: string, signal: AbortSignal) => Promise<ProviderResult>): DouyinProvider {
  return { timeoutMs: publicPage ? 180_000 : 30_000, async parse(input, signal) {
    const source = normalizeShare(input);
    let id = contentIdFromUrl(new URL(source));
    if (!id) {
      const response = await client(source, { scope: "page", signal });
      id = contentIdFromUrl(new URL(response.url));
      const body = await readText(response);
      if (!id) id = body.match(/"itemId"\s*:\s*"(\d{8,30})"/)?.[1] ?? null;
      if (!id) throw new VideoFailure("ENGINE_UNAVAILABLE");
    }
    signal.throwIfAborted();
    if (publicPage) return publicPage(id, source, signal);
    const endpoint = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${id}&aid=6383&device_platform=webapp`;
    const detail = parseJson(await readText(await client(endpoint, { scope: "page", signal })));
    signal.throwIfAborted();
    return normalizeDetail(detail, id, source);
  } };
}
