import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { publicLookup } from "./public-dns";
import { isPublicAddress } from "./network";
import { browserHostAllowed } from "./browser-policy";
import { VideoFailure } from "../../shared/video-parser";

// Per-parse loopback CONNECT tunnel. TLS stays end-to-end in Chromium; this
// process never decrypts website traffic/cookies. DNS is validated and pinned
// at the actual outgoing socket, including each new redirect destination.
export async function createBrowserProxy(signal: AbortSignal) {
  const username = "clarune"; const password = randomBytes(24).toString("hex");
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const sockets = new Set<Socket>();
  const server = createServer((_req, res) => { res.writeHead(405); res.end(); });
  server.headersTimeout = 10_000;
  server.on("connection", socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
  });
  server.on("connect", (req, socket, head) => {
    if (req.headers["proxy-authorization"] !== authorization) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Clarune parser"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return;
    }
    const match = /^([a-z0-9.-]+):443$/.exec(req.url ?? "");
    if (!match || !browserHostAllowed(match[1]) || signal.aborted) { socket.destroy(); return; }
    socket.pause();
    void publicLookup(match[1], signal).then(addresses => {
      if (signal.aborted || socket.destroyed || !addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new VideoFailure("BLOCKED_URL");
      const target = addresses.find(item => item.family === 4) ?? addresses[0];
      const upstream = connect({ host: target.address, family: target.family, port: 443 });
      sockets.add(upstream); upstream.once("close", () => { sockets.delete(upstream); socket.destroy(); });
      upstream.on("error", () => socket.destroy()); socket.once("close", () => upstream.destroy());
      upstream.setTimeout(30_000, () => upstream.destroy());
      upstream.once("connect", () => {
        if (signal.aborted || socket.destroyed) { upstream.destroy(); return; }
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream); upstream.pipe(socket); socket.resume();
      });
    }).catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= new Promise<void>(resolve => {
    signal.removeEventListener("abort", abort);
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  });
  const abort = () => { void close(); }; signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) { await close(); signal.throwIfAborted(); }
  return { port, username, password, close };
}
