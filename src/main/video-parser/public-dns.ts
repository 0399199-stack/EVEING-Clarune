import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { VideoFailure } from "../../shared/video-parser";

export function isProxyAddress(address: string): boolean {
  return /^198\.(?:18|19)\.\d{1,3}\.\d{1,3}$/.test(address);
}

// Some local TUN proxies return benchmark-range Fake-IP answers. Never connect
// to those as media targets: resolve the already allowlisted host over HTTPS,
// then let network.ts validate and pin the real public answers as usual.
// Only a hostname is sent to this fixed resolver, never a work ID or media URL.
export async function publicLookup(hostname: string, signal: AbortSignal): Promise<{ address: string; family: number }[]> {
  signal.throwIfAborted();
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || !addresses.every(item => isProxyAddress(item.address))) return addresses;
  const body = await new Promise<string>((resolve, reject) => {
    const req = request(`https://dns.alidns.com/resolve?name=${encodeURIComponent(hostname)}&type=A`, {
      method: "GET", agent: false, signal, headers: { Accept: "application/dns-json", "Accept-Encoding": "identity" },
    }, res => {
      if (res.statusCode !== 200) { res.destroy(); reject(new VideoFailure("NETWORK")); return; }
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 65536) { req.destroy(new VideoFailure("INVALID_DATA")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });
    const timer = setTimeout(() => req.destroy(new VideoFailure("TIMEOUT")), 8000);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end();
  });
  let data: { Status?: number; Answer?: { type: number; data: string }[] };
  try { data = JSON.parse(body); } catch { throw new VideoFailure("INVALID_DATA"); }
  if (!data || data.Status !== 0 || !Array.isArray(data.Answer)) throw new VideoFailure("NETWORK");
  return data.Answer.filter(item => item?.type === 1 && typeof item.data === "string").map(item => ({ address: item.data, family: 4 }));
}
