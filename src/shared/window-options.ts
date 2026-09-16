import type { BrowserWindowConstructorOptions } from "electron";

export function createWindowOptions(
  preloadPath: string,
  platform: NodeJS.Platform = process.platform,
): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: "#eef2f8",
    titleBarStyle: platform === "win32" ? "hidden" : "default",
    ...(platform === "win32"
      ? {
          titleBarOverlay: {
            color: "#00000000",
            symbolColor: "#5a6578",
            height: 44,
          },
          backgroundMaterial: "mica" as const,
        }
      : {}),
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  };
}
