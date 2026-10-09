// Hosts observed on the public desktop page and its verification UI. No login
// profile import, ad/analytics endpoints, generic URL proxy or media prefetch.
const hosts = new Set([
  "www.douyin.com", "lf-douyin-pc-web.douyinstatic.com", "sf1-cdn-tos.douyinstatic.com",
  "lf-security.bytegoofy.com", "lf-c-flwb.bytetos.com", "lf-cdn-tos.bytescm.com",
  "p-pc-weboff.byteimg.com", "lf-rc1.yhgfb-cn-static.com", "lf3-static.bytednsdoc.com",
  "mssdk.bytedance.com",
]);
export function browserHostAllowed(host: string): boolean { return hosts.has(host); }
export function browserRequestAllowed(value: string, resourceType: string, method: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !hosts.has(url.hostname)) return false;
    if (!["GET", "POST", "HEAD"].includes(method) || ["media", "ping", "webSocket"].includes(resourceType)) return false;
    if (method === "POST" && !["mssdk.bytedance.com", "lf-rc1.yhgfb-cn-static.com"].includes(url.hostname)) return false;
    return !/\/(?:play|playwm|collect|log|report|monitor|download)(?:\/|$)|\.(?:mp4|mp3|m4a|m3u8|ts)(?:$|\?)/i.test(url.pathname);
  } catch { return false; }
}
