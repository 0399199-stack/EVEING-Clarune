import { BrowserWindow, session } from "electron";
import { randomUUID } from "node:crypto";
import { VideoFailure } from "../../shared/video-parser";
import { delay } from "./network";
import { browserRequestAllowed } from "./browser-policy";
import { createBrowserProxy } from "./browser-proxy";

export async function readPublicDouyinPage(id: string, signal: AbortSignal): Promise<string> {
  if (!/^\d{8,30}$/.test(id)) throw new VideoFailure("INVALID_INPUT");
  signal.throwIfAborted();
  const proxy = await createBrowserProxy(signal);
  const partition = session.fromPartition(`clarune-douyin-${randomUUID()}`, { cache: false });
  let window: BrowserWindow | undefined;
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new AbortController();
  const combined = AbortSignal.any([signal, stopped.signal]);
  const abort = () => { if (window && !window.isDestroyed()) window.destroy(); };
  try {
    await partition.setProxy({ proxyRules: `http=127.0.0.1:${proxy.port};https=127.0.0.1:${proxy.port}`, proxyBypassRules: "<-loopback>" });
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    partition.setPermissionCheckHandler(() => false);
    partition.on("will-download", event => event.preventDefault());
    partition.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !browserRequestAllowed(details.url, details.resourceType, details.method) }));
    window = new BrowserWindow({ width: 1040, height: 780, show: false, autoHideMenuBar: true,
      title: "Clarune · 抖音公开页面 / Douyin public page",
      webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false, devTools: false, autoplayPolicy: "document-user-activation-required", backgroundThrottling: false },
    });
    window.removeMenu(); window.webContents.setAudioMuted(true);
    window.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-attach-webview", event => event.preventDefault());
    window.webContents.on("page-title-updated", event => event.preventDefault());
    window.webContents.on("will-navigate", (event, url) => {
      if (!browserRequestAllowed(url, "mainFrame", "GET") || new URL(url).hostname !== "www.douyin.com") event.preventDefault();
    });
    window.webContents.on("login", (event, _details, authInfo, callback) => {
      event.preventDefault();
      if (authInfo.isProxy && authInfo.host === "127.0.0.1" && authInfo.port === proxy.port) callback(proxy.username, proxy.password);
      else callback();
    });
    window.once("closed", () => stopped.abort());
    signal.addEventListener("abort", abort, { once: true });
    combined.throwIfAborted();
    // Slow/verification pages remain user-visible. Never solve/click a challenge.
    showTimer = setTimeout(() => { if (window && !window.isDestroyed()) window.show(); }, 6000);
    void window.loadURL(`https://www.douyin.com/jingxuan?modal_id=${id}`).catch(() => {});
    while (!combined.aborted) {
      // Read only the site's public JSON data block. No cookies, storage, signed
      // request generation, page functions or downloaded JS execute in main.
      // Electron can leave executeJavaScript pending if the window is closed
      // before its first document loads. Cancellation must not await that promise.
      const contents = window.webContents;
      const text = await new Promise<unknown>((resolve, reject) => {
        const cancel = () => { combined.removeEventListener("abort", cancel); reject(new VideoFailure("CANCELLED")); };
        combined.addEventListener("abort", cancel, { once: true });
        if (combined.aborted) { cancel(); return; }
        void contents.executeJavaScript('document.getElementById("RENDER_DATA")?.textContent?.slice(0, 4194305) || ""').then(value => {
          combined.removeEventListener("abort", cancel); resolve(value);
        }, () => { combined.removeEventListener("abort", cancel); resolve(""); });
      });
      if (typeof text === "string" && text.length > 4 * 1024 * 1024) throw new VideoFailure("INVALID_DATA");
      if (typeof text === "string" && text) return text;
      await delay(400, combined);
    }
    throw new VideoFailure("CANCELLED");
  } finally {
    clearTimeout(showTimer); signal.removeEventListener("abort", abort);
    if (window && !window.isDestroyed()) window.destroy();
    partition.webRequest.onBeforeRequest(null);
    await proxy.close();
    await partition.closeAllConnections();
    await partition.clearStorageData();
  }
}
