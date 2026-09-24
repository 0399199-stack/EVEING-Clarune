import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import type { DeviceComponentHashes } from "../../shared/license";
import { getWindowsDeviceHashes } from "./device";
import { LicenseService } from "./license-service";
import { createProtectedLicenseStore } from "./protected-store";

export function createProductionLicenseService(): LicenseService {
  let publicKeyPem: string | null = null;
  try {
    // Public-key selection cannot be overridden by a renderer, environment variable, or license payload.
    const resourcesDirectory = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources");
    const bytes = readFileSync(join(resourcesDirectory, "license-public-key.pem"));
    const text = bytes.toString("utf8");
    if (bytes.length <= 4096 && text.includes("-----BEGIN PUBLIC KEY-----") && !text.includes("PRIVATE KEY")) publicKeyPem = text;
  } catch { /* An unconfigured build must remain locked. */ }
  let device: Promise<DeviceComponentHashes> | undefined;
  return new LicenseService({
    publicKeyPem,
    store: createProtectedLicenseStore(join(app.getPath("userData"), "activation-state.bin"), safeStorage),
    getDevice: () => {
      device ??= getWindowsDeviceHashes();
      return device.catch((error: unknown) => { device = undefined; throw error; });
    },
  });
}
