import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { ClaruneAPI } from "../shared/contracts";
import { IPC_CHANNELS } from "../shared/contracts";
import { IMAGE_TOOL_CHANNELS, type BatchProgress, type EnhancementProgress } from "../shared/image-tools";

let pendingExports = 0;
async function exportFile<T>(channel: string, ...args: unknown[]): Promise<T> {
  pendingExports++;
  try {
    const result = await ipcRenderer.invoke(channel, ...args);
    if (result?.ok === false && result.error === "LICENSE_REQUIRED") window.dispatchEvent(new Event("clarune:license-required"));
    return result;
  }
  finally { pendingExports--; }
}
window.addEventListener("beforeunload", (event) => {
  if (pendingExports > 0) {
    event.preventDefault();
    // Electron requires returnValue as well as preventDefault to cancel reload.
    event.returnValue = "";
  }
});

const api: ClaruneAPI = Object.freeze<ClaruneAPI>({
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appInfo),
  getLicenseStatus: () => ipcRenderer.invoke(IPC_CHANNELS.licenseStatus),
  activateLicense: (text) => exportFile(IPC_CHANNELS.licenseActivate, text),
  copyMachineCode: () => ipcRenderer.invoke(IPC_CHANNELS.licenseCopyMachine),
  processImage: (job) => ipcRenderer.invoke(IMAGE_TOOL_CHANNELS.process, job),
  saveImage: (job, suggestedName) => exportFile(IMAGE_TOOL_CHANNELS.save, job, suggestedName),
  savePdf: (job, suggestedName) => exportFile(IMAGE_TOOL_CHANNELS.pdf, job, suggestedName),
  getSystemFonts: () => ipcRenderer.invoke(IMAGE_TOOL_CHANNELS.fonts),
  saveBatch: (job) => exportFile(IMAGE_TOOL_CHANNELS.batch, job),
  cancelBatch: (id) => ipcRenderer.invoke(IMAGE_TOOL_CHANNELS.cancelBatch, id),
  onBatchProgress: (handler) => {
    const listener = (_event: IpcRendererEvent, progress: BatchProgress) => handler(progress);
    ipcRenderer.on(IMAGE_TOOL_CHANNELS.batchProgress, listener);
    return () => ipcRenderer.removeListener(IMAGE_TOOL_CHANNELS.batchProgress, listener);
  },
  openOutput: (path) => ipcRenderer.invoke(IMAGE_TOOL_CHANNELS.openOutput, path),
  copyOutputPath: (path) => ipcRenderer.invoke(IMAGE_TOOL_CHANNELS.copyOutputPath, path),
  getUpscaleStatus: (model) => ipcRenderer.invoke(IMAGE_TOOL_CHANNELS.upscaleStatus, model),
  selectUpscaleRuntime: (model) => ipcRenderer.invoke(IMAGE_TOOL_CHANNELS.selectUpscaleRuntime, model),
  enhanceImage: (job) => exportFile(IMAGE_TOOL_CHANNELS.enhance, job),
  saveLargeEnhancement: (id, format, quality, suggestedName) => exportFile(IMAGE_TOOL_CHANNELS.saveLargeEnhancement, id, format, quality, suggestedName),
  discardLargeEnhancement: (id) => ipcRenderer.invoke(IMAGE_TOOL_CHANNELS.discardLargeEnhancement, id),
  cancelEnhancement: (id) => ipcRenderer.invoke(IMAGE_TOOL_CHANNELS.cancelEnhancement, id),
  onEnhancementProgress: (handler) => {
    const listener = (_event: IpcRendererEvent, progress: EnhancementProgress) => handler(progress);
    ipcRenderer.on(IMAGE_TOOL_CHANNELS.enhancementProgress, listener);
    return () => ipcRenderer.removeListener(IMAGE_TOOL_CHANNELS.enhancementProgress, listener);
  },
});

contextBridge.exposeInMainWorld("clarune", api);
