import { request } from "node:https";
import { isIP, BlockList } from "node:net";
import { Readable } from "node:stream";
import { VideoFailure, shareUrl } from "../../shared/video-parser";
import { publicLookup } from "./public-dns";

export type NetworkScope = "page" | "media";
export interface NetResponse { status: number; headers: Record<string, string>; url: string; body: Readable; close: () => void }
export interface NetOptions { scope: NetworkScope; signal: AbortSignal; headers?: Record<string, string> }
export type NetClient = (url: string, options: NetOptions) => Promise<NetResponse>;

const blocked = new BlockList();
const blockedV6 = new BlockList();
for (const [ip, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]] as const) blocked.addSubnet(ip, bits, "ipv4");
for (const [ip, bits] of [["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]] as const) blockedV6.addSubnet(ip, bits, "ipv6");
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, "ipv4") : family === 6 && /^[23]/.test(address) && !blockedV6.check(address, "ipv6");
}

// Only reviewed platform media domains. Never turn this into an arbitrary URL proxy.
const cdnDomains = ["douyinvod.com", "douyinpic.com", "byteimg.com", "pstatp.com", "ibytedtos.com"];
export function validateNetworkUrl(value: string, scope: NetworkScope): URL {
  if (scope === "page") return shareUrl(value);
  let url: URL;
  try { url = new URL(value); } catch { throw new VideoFailure("BLOCKED_URL"); }
  const host = url.hostname.toLowerCase();
  const allowed = cdnDomains.some(domain => host === domain || host.endsWith(`.${domain}`)) || (host === "www.iesdouyin.com" && url.pathname === "/aweme/v1/play/");
  if (!allowed || !["https:", "http:"].includes(url.protocol) || url.port || url.username || url.password) throw new VideoFailure("BLOCKED_URL");
  url.protocol = "https:"; url.hash = "";
  return url;
}
const userAgent = "Mozilla/5.0 (Linux; Android 11; SAMSUNG SM-G973U) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/14.2 Chrome/87.0.4280.141 Mobile Safari/537.36";
const desktopUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

/** DNS results are vetted AND pinned to the actual socket; each redirect repeats this check. */
export const secureRequest: NetClient = async (value, options) => {
  let url = validateNetworkUrl(value, options.scope);
  for (let redirect = 0; redirect <= 5; redirect++) {
    options.signal.throwIfAborted();
    const response = await new Promise<NetResponse>((resolve, reject) => {
      let connectTimer: ReturnType<typeof setTimeout>;
      const req = request(url, {
        method: "GET", agent: false, signal: options.signal,
        headers: { "User-Agent": options.scope === "media" ? desktopUserAgent : userAgent, "Referer": "https://www.douyin.com/", "Accept-Encoding": "identity", ...Object.fromEntries(Object.entries(options.headers ?? {}).filter(([key]) => ["range", "if-range"].includes(key.toLowerCase()))) },
        lookup: (hostname, _opts, callback) => {
          void publicLookup(hostname, options.signal).then(addresses => {
            if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new VideoFailure("BLOCKED_URL");
            // Return only vetted addresses, including Node's all-address lookup mode.
            const first = addresses[0];
            if (_opts.all) callback(null, addresses);
            else callback(null, first.address, first.family);
          }).catch(error => callback(error, "", 4));
        },
      }, res => {
        clearTimeout(connectTimer);
        const headers: Record<string, string> = {};
        for (const [key, val] of Object.entries(res.headers)) if (val !== undefined) headers[key] = Array.isArray(val) ? val[0] : val;
        // Errors after headers belong to the stream, not an already-settled promise.
        req.on("error", error => res.destroy(error));
        resolve({ status: res.statusCode ?? 0, headers, url: url.href, body: res, close: () => { res.destroy(); req.destroy(); } });
      });
      connectTimer = setTimeout(() => req.destroy(new VideoFailure("TIMEOUT")), 10_000);
      req.setTimeout(60_000, () => req.destroy(new VideoFailure("TIMEOUT")));
      req.on("error", error => { clearTimeout(connectTimer); reject(error); });
      req.end();
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    response.close();
    if (!response.headers.location || redirect === 5) throw new VideoFailure("BLOCKED_URL");
    url = validateNetworkUrl(new URL(response.headers.location, url).href, options.scope);
  }
  throw new VideoFailure("BLOCKED_URL");
};

export function checkStatus(response: NetResponse): void {
  const status = response.status;
  if (status >= 200 && status < 300) return;
  if (status === 429) {
    const text = response.headers["retry-after"];
    const delay = /^\d+$/.test(text ?? "") ? Number(text) * 1000 : Date.parse(text ?? "") - Date.now();
    throw new VideoFailure("RATE_LIMIT", Number.isFinite(delay) ? Math.max(1000, delay) : 60_000);
  }
  if ([401, 403].includes(status)) throw new VideoFailure("ACCESS_DENIED");
  if ([404, 410].includes(status)) throw new VideoFailure("NOT_FOUND");
  throw new VideoFailure("NETWORK");
}
export async function readText(response: NetResponse, limit = 4 * 1024 * 1024): Promise<string> {
  try {
    checkStatus(response);
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new VideoFailure("INVALID_DATA");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { response.close(); }
}
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new VideoFailure("CANCELLED")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
