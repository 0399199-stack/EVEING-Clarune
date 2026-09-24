import { app, BrowserWindow, ipcMain, Menu } from "electron";
import { join, resolve } from "node:path";
import { IPC_CHANNELS } from "../shared/contracts";
import { createWindowOptions } from "../shared/window-options";
import { registerImageTools, trustedFrame, type ImageToolsLifecycle } from "./image-tools/ipc";
import { protectOutputClose } from "./image-tools/window-close";
import { OutputRegistry } from "./image-tools/output-registry";
import { isDevelopmentShortcut } from "./release-shortcuts";
import { createProductionLicenseService } from "./license/production";
import { registerLicenseIpc } from "./license-ipc";
import { ImageToolError } from "./image-tools/errors";

let mainWindow: BrowserWindow | null = null;
let imageTools: ImageToolsLifecycle;

app.setName("EVEING Clarune");
if (process.platform === "win32") app.setAppUserModelId("com.eveing.clarune");

function registerIpc(): void {
  const license = createProductionLicenseService();
  const licenseIpc = registerLicenseIpc(() => mainWindow, license);
  ipcMain.handle(IPC_CHANNELS.appInfo, (event) => {
    if (!trustedFrame(event, mainWindow)) {
      throw new Error("Untrusted IPC sender");
    }
    return {
      name: "EVEING Clarune",
      version: app.getVersion(),
      platform: process.platform,
    };
  });
  const localRuntime = app.isPackaged ? join(process.resourcesPath, "ai/ncnn") : resolve(app.getAppPath(), "../..", "work/engine-baseline/runtime-full");
  const localRealHat = app.isPackaged ? join(process.resourcesPath, "ai/realhat") : resolve(app.getAppPath(), "../..", "work/realhat-face-test");
  const realHatWorker = join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources"), "realhat-worker.py");
  const outputLifecycle = registerImageTools(() => mainWindow, new OutputRegistry(join(app.getPath("userData"), "saved-outputs.json")), [localRuntime], { worker: realHatWorker, candidates: [localRealHat] }, async () => {
    try { await license.requireActive(); }
    catch { throw new ImageToolError("LICENSE_REQUIRED"); }
  });
  imageTools = { requestOutputStop: () => {
    licenseIpc.stopAcceptingRequests();
    return Promise.allSettled([outputLifecycle.requestOutputStop(), license.whenIdle()]).then(() => undefined);
  } };
}

function createWindow(): void {
  const window = new BrowserWindow(
    { ...createWindowOptions(join(__dirname, "../preload/index.js")),
      title: "EVEING Clarune", icon: join(app.getAppPath(), "resources/branding/clarune.ico") },
  );

  mainWindow = window;
  protectOutputClose(window, imageTools);
  if (app.isPackaged || !process.env.ELECTRON_RENDERER_URL) {
    window.removeMenu();
    window.webContents.on("before-input-event", (event, input) => {
      if (isDevelopmentShortcut(input)) event.preventDefault();
    });
  }
  window.once("ready-to-show", () => window.show());
  window.webContents.once("did-finish-load", () => {
    if (!window.isVisible()) window.show();
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  const rendererUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) void window.loadURL(rendererUrl);
  else void window.loadFile(join(__dirname, "../renderer/index.html"));
}

const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on("second-instance", () => {
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.show(); mainWindow?.focus();
});
if (ownsInstance) app.whenReady().then(() => {
  if (app.isPackaged || !process.env.ELECTRON_RENDERER_URL) Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
