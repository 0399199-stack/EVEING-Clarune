import { contextBridge, ipcRenderer } from "electron";
import type { ClaruneAPI } from "../shared/contracts";
import { IPC_CHANNELS } from "../shared/contracts";

const api: ClaruneAPI = Object.freeze({
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appInfo),
});

contextBridge.exposeInMainWorld("clarune", api);
