import { clipboard, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS } from "../shared/contracts";
import { trustedFrame } from "./image-tools/ipc";
import type { LicenseService } from "./license/license-service";

export function registerLicenseIpc(getWindow: () => BrowserWindow | null, license: LicenseService): { stopAcceptingRequests(): void } {
  let closing = false;
  const check = (event: IpcMainInvokeEvent) => {
    if (closing) throw new Error("Application is closing");
    if (!trustedFrame(event, getWindow())) throw new Error("Untrusted IPC sender");
  };
  ipcMain.handle(IPC_CHANNELS.licenseStatus, async event => {
    check(event);
    return license.getStatus();
  });
  ipcMain.handle(IPC_CHANNELS.licenseActivate, async (event, text: unknown) => {
    check(event);
    if (typeof text !== "string" || text.length > 16_384) return { state: "invalid", error: "LICENSE_FORMAT_INVALID" };
    return license.activate(text);
  });
  ipcMain.handle(IPC_CHANNELS.licenseCopyMachine, async event => {
    check(event);
    const status = await license.getStatus();
    check(event);
    if (!status.machineCode) return false;
    clipboard.writeText(status.machineCode);
    return true;
  });
  return { stopAcceptingRequests: () => { closing = true; } };
}
