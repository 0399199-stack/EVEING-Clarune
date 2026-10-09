import { VideoFailure } from "../../shared/video-parser";
import { normalizeDetail } from "./douyin-provider";

const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
function mediaUrls(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [value];
  return entries.map(item => typeof item === "string" ? item : object(item).src).filter((item): item is string => typeof item === "string" && !!item).map(item => item.startsWith("//") ? `https:${item}` : item);
}

export function normalizeBrowserData(text: string, id: string, source: string) {
  let root: Record<string, any>;
  try {
    if (text.length > 4 * 1024 * 1024) throw new Error();
    root = object(JSON.parse(decodeURIComponent(text)));
  } catch { throw new VideoFailure("INVALID_DATA"); }
  const detail = object(object(root.app).videoDetail);
  if (detail.awemeId !== id) throw new VideoFailure("NOT_FOUND");
  const status = object(detail.status);
  if (detail.isPrivate || detail.isFriendLimit || status.isDelete || status.isProhibited || status.isReviewing || (status.privateStatus !== undefined && status.privateStatus !== 0)) throw new VideoFailure("ACCESS_DENIED");
  const video = object(detail.video);
  const images = Array.isArray(detail.images) && detail.images.length ? detail.images.map((item: unknown) => {
    const image = object(item);
    return { width: image.width, height: image.height, url_list: mediaUrls(image.urlList ?? image.url_list) };
  }) : undefined;
  return normalizeDetail({ aweme_detail: {
    aweme_id: detail.awemeId, desc: detail.desc, author: { nickname: object(detail.authorInfo).nickname }, images,
    video: { width: video.width, height: video.height, duration: video.duration,
      play_addr: { url_list: mediaUrls(video.playAddr) }, cover: { url_list: mediaUrls(video.coverUrlList ?? video.cover) },
    },
    music: { play_url: { url_list: mediaUrls(object(detail.music).playUrl) } },
  } }, id, source);
}
