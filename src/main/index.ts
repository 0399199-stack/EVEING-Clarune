import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { IPC_CHANNELS } from "../shared/contracts";
import { createWindowOptions } from "../shared/window-options";

let mainWindow: BrowserWindow | null = null;

function registerIpc(): void {
  ipcMain.handle(IPC_CHANNELS.appInfo, (event) => {
    if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) {
      throw new Error("Untrusted IPC sender");
    }
    return {
      name: "EVEING Clarune",
      version: app.getVersion(),
      platform: process.platform,
    };
  });

}

function createWindow(): void {
  const window = new BrowserWindow(
    createWindowOptions(join(__dirname, "../preload/index.js")),
  );

  mainWindow = window;
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

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) void window.loadURL(rendererUrl);
  else void window.loadFile(join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
