import { app, clipboard, dialog, ipcMain, protocol, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { VIDEO_CHANNEL, VideoFailure, videoError, type VideoParserAPI } from "../../shared/video-parser";
import { trustedFrame } from "../image-tools/ipc";
import { DOUYIN_ENGINE, createDouyinProvider } from "./douyin-provider";
import { secureRequest } from "./network";
import { VideoService } from "./service";
import { readPublicDouyinPage } from "./browser-reader";
import { normalizeBrowserData } from "./browser-data";

export function registerVideoParser(getWindow: () => BrowserWindow | null, requireLicense: () => Promise<void>): VideoService {
  const emit = (event: string, value?: unknown) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(VIDEO_CHANNEL + event, value);
  };
  const service = new VideoService({
    storagePath: join(app.getPath("userData"), "video-parser-v1.json"),
    defaultDirectory: join(app.getPath("downloads"), "EVEING Clarune", "Douyin"),
    provider: createDouyinProvider(secureRequest, async (id, source, signal) => {
      const result = normalizeBrowserData(await readPublicDouyinPage(id, signal), id, source);
      if (app.isPackaged && !DOUYIN_ENGINE.verifiedMedia[result.mediaType]) throw new VideoFailure("GALLERY_UNVERIFIED");
      return result;
    }), client: secureRequest,
    // A packaged build cannot claim platform support before the opt-in real tests pass.
    engineAvailable: !app.isPackaged || Object.values(DOUYIN_ENGINE.verifiedMedia).some(Boolean),
    changed: () => emit("changed"), parseProgress: progress => emit("progress", progress),
    requireLicense: async () => { try { await requireLicense(); } catch { throw new VideoFailure("LICENSE_REQUIRED"); } },
  });
  const handle = (name: keyof VideoParserAPI, run: (...args: any[]) => Promise<unknown> | unknown) => {
    ipcMain.handle(VIDEO_CHANNEL + name, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      try {
        if (!trustedFrame(event, getWindow())) throw new VideoFailure("ACCESS_DENIED");
        return { ok: true, value: await run(...args) };
      } catch (error) { return { ok: false, error: videoError(error) }; }
    });
  };
  handle("parse", (id, text) => service.parse(id, text));
  handle("cancel", id => service.cancel(id));
  handle("release", ids => { service.release(ids); return true; });
  handle("snapshot", () => service.snapshot());
  handle("chooseDirectory", async () => {
    const window = getWindow()!;
    const chosen = await dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"], defaultPath: (await service.snapshot()).directory });
    if (chosen.canceled || !chosen.filePaths[0]) return null;
    await service.setDirectory(chosen.filePaths[0]); return (await service.snapshot()).directory;
  });
  handle("setConcurrency", async value => { await service.setConcurrency(value); return true; });
  handle("enqueue", (id, kind) => service.enqueue(id, kind));
  handle("taskAction", async (id, action) => {
    if (!["pause", "resume", "cancel", "retry", "reveal"].includes(action)) throw new VideoFailure("INVALID_INPUT");
    if (action === "reveal") shell.showItemInFolder(await service.outputPath(id));
    else await service.taskAction(id, action);
    return true;
  });
  handle("preview", (id, resourceId) => service.preview(id, resourceId));
  handle("stopPreview", () => { service.stopPreview(); return true; });
  handle("copySource", async id => { await clipboard.writeText(service.source(id)); return true; });
  handle("paste", async () => (await clipboard.readText()).slice(0, 128_000));
  handle("importText", async () => {
    const result = await dialog.showOpenDialog(getWindow()!, { properties: ["openFile"], filters: [{ name: "UTF-8 TXT", extensions: ["txt"] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const path = result.filePaths[0];
    if ((await stat(path)).size > 128_000) throw new VideoFailure("INVALID_INPUT");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path)); }
    catch { throw new VideoFailure("INVALID_INPUT"); }
  });
  handle("clearHistory", async () => { await service.clearHistory(); return true; });
  protocol.handle("clarune-media", request => service.previewResponse(request));
  return service;
}
