export const LICENSE_PRODUCT_ID = "eveing-clarune";
export const DEVICE_REQUEST_PREFIX = "CLARUNE-DEVICE-1.";
export const LICENSE_TOKEN_PREFIX = "CLARUNE-LICENSE-1.";
export const MAX_LICENSE_TEXT_LENGTH = 16_384;

export interface DeviceComponentHashes {
  machine_guid: string;
  smbios_uuid: string;
}

export interface DeviceRequest {
  version: 1;
  product_id: typeof LICENSE_PRODUCT_ID;
  device_component_hashes: DeviceComponentHashes;
}

export interface LicenseStatus {
  state: "unconfigured" | "inactive" | "active" | "expired" | "not-yet-valid"
    | "clock-rollback" | "device-mismatch" | "invalid" | "device-unavailable";
  machineCode?: string;
  licenseId?: string;
  notBefore?: string;
  expiresAt?: string | null;
  error?: string;
}
