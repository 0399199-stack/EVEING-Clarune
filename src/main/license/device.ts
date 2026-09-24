import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DEVICE_REQUEST_PREFIX, LICENSE_PRODUCT_ID, type DeviceComponentHashes, type DeviceRequest } from "../../shared/license";
import { LicenseError } from "./verify-license";

const knownPlaceholders = new Set([
  "03000200-0400-0500-0006-000700080009",
  "00020003-0004-0005-0006-000700080009",
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
]);

export function normalizeDeviceIdentifier(value: string): string {
  const compact = value.trim().replace(/^\{(.*)\}$/, "$1").replace(/-/g, "").toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(compact) || /^(.)\1+$/.test(compact)) {
    throw new LicenseError("DEVICE_UNAVAILABLE", "A valid machine GUID and SMBIOS UUID are both required");
  }
  const normalized = `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
  if (knownPlaceholders.has(normalized)) {
    throw new LicenseError("DEVICE_UNAVAILABLE", "The machine reports a placeholder hardware identifier");
  }
  return normalized;
}

export function hashDeviceIdentifier(name: keyof DeviceComponentHashes, value: string): string {
  return createHash("sha256")
    .update(`${LICENSE_PRODUCT_ID}\0device-v1\0${name}\0${normalizeDeviceIdentifier(value)}`, "utf8")
    .digest("hex");
}

export function assertDeviceHashes(value: unknown): asserts value is DeviceComponentHashes {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LicenseError("DEVICE_UNAVAILABLE", "Both device components are required");
  }
  const entries = Object.entries(value);
  if (entries.length !== 2 || entries.some(([name, hash]) =>
    !["machine_guid", "smbios_uuid"].includes(name) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) {
    throw new LicenseError("DEVICE_UNAVAILABLE", "Both valid device components are required");
  }
}

export function encodeDeviceRequest(hashes: DeviceComponentHashes): string {
  assertDeviceHashes(hashes);
  const request: DeviceRequest = {
    version: 1,
    product_id: LICENSE_PRODUCT_ID,
    device_component_hashes: { machine_guid: hashes.machine_guid, smbios_uuid: hashes.smbios_uuid },
  };
  return DEVICE_REQUEST_PREFIX + Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
}

type RunDeviceCommand = (file: string, args: string[]) => Promise<string>;

const runDeviceCommand: RunDeviceCommand = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024, encoding: "utf8" }, (error, stdout) => {
    // Never expose command output or the raw identifiers in an error message.
    if (error) reject(new LicenseError("DEVICE_UNAVAILABLE", "Windows hardware identification is unavailable"));
    else resolve(stdout);
  });
});

export async function getWindowsDeviceHashes(run: RunDeviceCommand = runDeviceCommand): Promise<DeviceComponentHashes> {
  if (process.platform !== "win32") throw new LicenseError("DEVICE_UNAVAILABLE", "This activation requires Windows");
  const windowsDirectory = process.env.SystemRoot || "C:\\Windows";
  try {
    const [registry, smbios] = await Promise.all([
      run(join(windowsDirectory, "System32", "reg.exe"), ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"]),
      run(join(windowsDirectory, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; (Get-CimInstance -ClassName Win32_ComputerSystemProduct -ErrorAction Stop).UUID",
      ]),
    ]);
    const machineGuid = registry.match(/\bMachineGuid\s+REG_SZ\s+([^\r\n]+)/i)?.[1];
    if (!machineGuid) throw new Error("missing machine guid");
    return {
      machine_guid: hashDeviceIdentifier("machine_guid", machineGuid),
      smbios_uuid: hashDeviceIdentifier("smbios_uuid", smbios.replace(/^\uFEFF/, "")),
    };
  } catch {
    throw new LicenseError("DEVICE_UNAVAILABLE", "Both a valid Windows machine GUID and SMBIOS UUID are required; check Windows WMI and hardware identifiers");
  }
}
