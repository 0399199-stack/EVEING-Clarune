export type ParseState = "idle" | "validating" | "parsing" | "succeeded" | "failed" | "cancelled";
export type DownloadState = "queued" | "downloading" | "paused" | "completed" | "failed" | "cancelled";
export type AssetKind = "video" | "image" | "cover" | "audio";
export type VideoError = "INVALID_INPUT" | "UNSUPPORTED_LINK" | "TOO_MANY_LINKS" | "BLOCKED_URL" | "NETWORK" | "TIMEOUT" | "RATE_LIMIT" | "ACCESS_DENIED" | "NOT_FOUND" | "ENGINE_UNAVAILABLE" | "GALLERY_UNVERIFIED" | "INVALID_DATA" | "EMPTY_MEDIA" | "INVALID_MEDIA" | "TRUNCATED" | "RANGE_MISMATCH" | "SESSION_EXPIRED" | "CANCELLED" | "FILE_ERROR" | "MISSING_FILE" | "QUEUE_FULL" | "LICENSE_REQUIRED";
export type VideoReply<T> = { ok: true; value: T } | { ok: false; error: VideoError };
export interface MediaAsset {
  resourceId: string;
  kind: AssetKind;
  order: number;
  format: string | null;
  width: number | null;
  height: number | null;
  size: number | null;
}
export interface ParsedVideo {
  sessionId: string;
  platform: "douyin";
  contentId: string;
  sourceUrl: string;
  canonicalUrl: string;
  mediaType: "video" | "gallery";
  title: string;
  authorName: string;
  cover: MediaAsset | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  assets: MediaAsset[];
  variants: { resourceId: string; label: string }[];
  capabilities: { preview: boolean; download: boolean; copyDirectLink: boolean };
  engineId: string;
  engineVersion: string;
  parsedAt: string;
}
export interface ParseRecord {
  id: string; sourceUrl: string; contentId: string | null; title: string; authorName: string;
  mediaType: "video" | "gallery" | null; at: string; state: "succeeded" | "failed" | "cancelled"; error?: VideoError;
}
export interface ParseItem { sourceUrl: string; state: ParseRecord["state"]; result?: ParsedVideo; error?: VideoError; duplicate?: boolean }
export interface ParseProgress { requestId: string; completed: number; total: number }
export interface DownloadTask {
  id: string; sourceUrl: string; contentId: string; title: string; kind: AssetKind;
  state: DownloadState; bytes: number; total: number | null; speed: number;
  completed: number; count: number; paths: string[]; createdAt: string; error?: VideoError;
  restartRequired: boolean;
}
export interface VideoSnapshot { directory: string; concurrency: number; tasks: DownloadTask[]; history: ParseRecord[]; engineAvailable: boolean; storageError?: boolean }
export interface VideoParserAPI {
  parse: (requestId: string, text: string) => Promise<VideoReply<ParseItem[]>>;
  cancel: (requestId: string) => Promise<VideoReply<boolean>>;
  release: (sessionIds: string[]) => Promise<VideoReply<boolean>>;
  snapshot: () => Promise<VideoReply<VideoSnapshot>>;
  chooseDirectory: () => Promise<VideoReply<string | null>>;
  setConcurrency: (value: number) => Promise<VideoReply<boolean>>;
  enqueue: (sessionId: string, kind: AssetKind) => Promise<VideoReply<DownloadTask>>;
  taskAction: (id: string, action: "pause" | "resume" | "cancel" | "retry" | "reveal") => Promise<VideoReply<boolean>>;
  preview: (sessionId: string, resourceId: string) => Promise<VideoReply<string>>;
  stopPreview: () => Promise<VideoReply<boolean>>;
  copySource: (sessionId: string) => Promise<VideoReply<boolean>>;
  paste: () => Promise<VideoReply<string>>;
  importText: () => Promise<VideoReply<string | null>>;
  clearHistory: () => Promise<VideoReply<boolean>>;
  onChange: (handler: () => void) => () => void;
  onParseProgress: (handler: (value: ParseProgress) => void) => () => void;
}
export const VIDEO_CHANNEL = "video-parser:";

export class VideoFailure extends Error {
  constructor(readonly code: VideoError, readonly retryAfterMs = 0) { super(code); }
}
export function videoError(error: unknown): VideoError {
  if (error instanceof VideoFailure) return error.code;
  if (error instanceof Error && error.name === "AbortError") return "CANCELLED";
  return "NETWORK";
}

const shareHosts = new Set(["douyin.com", "www.douyin.com", "m.douyin.com", "v.douyin.com", "iesdouyin.com", "www.iesdouyin.com"]);
export function shareUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new VideoFailure("INVALID_INPUT"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port || !shareHosts.has(url.hostname.toLowerCase())) throw new VideoFailure("BLOCKED_URL");
  url.protocol = "https:";
  url.hash = "";
  return url;
}
export function contentIdFromUrl(url: URL): string | null {
  const pathId = url.pathname.match(/^\/(?:share\/)?(?:video|note|slides)\/(\d{8,30})\/?$/)?.[1];
  if (pathId) return pathId;
  if (!["douyin.com", "www.douyin.com"].includes(url.hostname) || !/^\/(?:jingxuan\/?)?$/.test(url.pathname)) return null;
  const ids = url.searchParams.getAll("modal_id");
  return ids.length === 1 && /^\d{8,30}$/.test(ids[0]) ? ids[0] : null;
}
export function normalizeShare(value: string): string {
  const url = shareUrl(value);
  if (url.hostname === "v.douyin.com" && /^\/[a-zA-Z0-9_-]{2,100}\/?$/.test(url.pathname)) {
    return `https://v.douyin.com/${url.pathname.split("/")[1]}/`;
  }
  const id = contentIdFromUrl(url);
  if (!id) throw new VideoFailure("UNSUPPORTED_LINK");
  const kind = /\/(note|slides)\//.test(url.pathname) ? "note" : "video";
  return `https://www.douyin.com/${kind}/${id}`;
}
export function prepareShareInputs(text: string): { sourceUrl: string; error?: VideoError }[] {
  if (typeof text !== "string" || !text.trim() || text.length > 128_000) throw new VideoFailure("INVALID_INPUT");
  const matches = text.match(/https?:\/\/[^\s<>"'\u3000]+/gi) ?? [];
  if (!matches.length) throw new VideoFailure("INVALID_INPUT");
  const inputs = [...new Set(matches.map(value => value.replace(/[，。；：、！？）】》」』.,;!?)\]}]+$/u, "")))];
  const seen = new Set<string>();
  const items = inputs.flatMap(value => {
    try {
      const sourceUrl = normalizeShare(value);
      if (seen.has(sourceUrl)) return [];
      seen.add(sourceUrl); return [{ sourceUrl }];
    } catch (error) { return [{ sourceUrl: "", error: videoError(error) }]; }
  });
  if (items.length > 100) throw new VideoFailure("TOO_MANY_LINKS");
  return items;
}
export function extractShareLinks(text: string): string[] {
  const inputs = prepareShareInputs(text);
  const invalid = inputs.find(item => item.error);
  if (invalid) throw new VideoFailure(invalid.error!);
  return inputs.map(item => item.sourceUrl);
}
