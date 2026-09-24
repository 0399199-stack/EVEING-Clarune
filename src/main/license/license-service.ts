import { createHash, createPublicKey } from "node:crypto";
import { LICENSE_PRODUCT_ID, type DeviceComponentHashes, type LicenseStatus } from "../../shared/license";
import { assertDeviceHashes, encodeDeviceRequest } from "./device";
import { LicenseError, readVerifiedLicense, type LicenseClaims } from "./verify-license";

const CLOCK_TOLERANCE_MS = 5 * 60_000;

interface LicenseSequence {
  licenseId: string;
  sequence: number;
  claimsHash: string;
}

export interface StoredLicenseState {
  version: 1;
  licenseText: string | null;
  lastSeen: number;
  sequences: LicenseSequence[];
}

export interface LicenseStateStore {
  load(): Promise<unknown | null>;
  save(state: StoredLicenseState): Promise<void>;
}

export interface LicenseServiceOptions {
  publicKeyPem: string | null;
  store: LicenseStateStore;
  getDevice(): Promise<DeviceComponentHashes>;
  now?: () => Date;
}

function canonicalClaimsHash(claims: LicenseClaims): string {
  return createHash("sha256").update(JSON.stringify({
    product_id: claims.product_id,
    license_id: claims.license_id,
    not_before: claims.not_before,
    expires_at: claims.expires_at,
    sequence: claims.sequence,
    device_match_min: claims.device_match_min,
    device_component_hashes: {
      machine_guid: claims.device_component_hashes.machine_guid,
      smbios_uuid: claims.device_component_hashes.smbios_uuid,
    },
  })).digest("hex");
}

function validateStoredState(value: unknown): StoredLicenseState {
  if (!value || typeof value !== "object") throw new LicenseError("STORAGE_INVALID", "Stored activation is invalid");
  const state = value as StoredLicenseState;
  if (state.version !== 1 || (state.licenseText !== null && (typeof state.licenseText !== "string" || state.licenseText.length > 16_384))
      || !Number.isSafeInteger(state.lastSeen) || state.lastSeen < 0
      || !Array.isArray(state.sequences) || state.sequences.length > 128
      || state.sequences.some((item) => !item || typeof item.licenseId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(item.licenseId)
        || !Number.isSafeInteger(item.sequence) || item.sequence < 1 || !/^[a-f0-9]{64}$/.test(item.claimsHash))
      || new Set(state.sequences.map((item) => item.licenseId)).size !== state.sequences.length) {
    throw new LicenseError("STORAGE_INVALID", "Stored activation is invalid");
  }
  return state;
}

function statusForClaims(claims: LicenseClaims, now: number): LicenseStatus {
  return {
    state: now < Date.parse(claims.not_before) ? "not-yet-valid"
      : claims.expires_at !== null && now >= Date.parse(claims.expires_at) ? "expired" : "active",
    licenseId: claims.license_id,
    notBefore: claims.not_before,
    expiresAt: claims.expires_at,
  };
}

export class LicenseService {
  private pending: Promise<unknown> = Promise.resolve();
  private state: StoredLicenseState | null = null;
  private readonly keyConfigured: boolean;

  constructor(private readonly options: LicenseServiceOptions) {
    try { this.keyConfigured = createPublicKey(options.publicKeyPem ?? "").asymmetricKeyType === "ed25519"; }
    catch { this.keyConfigured = false; }
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.then(work);
    this.pending = result.catch(() => undefined);
    return result;
  }

  whenIdle(): Promise<void> { return this.pending.then(() => undefined); }

  getStatus(): Promise<LicenseStatus> { return this.serial(() => this.evaluate()); }

  activate(licenseText: string): Promise<LicenseStatus> { return this.serial(() => this.evaluate(licenseText)); }

  async requireActive(): Promise<void> {
    const status = await this.getStatus();
    if (status.state !== "active") throw new LicenseError("LICENSE_REQUIRED", status.error ?? `License is ${status.state}`);
  }

  private async evaluate(candidate?: string): Promise<LicenseStatus> {
    let machineCode: string | undefined;
    try {
      const hashes = await this.options.getDevice();
      assertDeviceHashes(hashes);
      machineCode = encodeDeviceRequest(hashes);
      if (!this.keyConfigured) return { state: "unconfigured", machineCode, error: "LICENSE_KEY_UNCONFIGURED" };
      if (this.state === null) {
        const loaded = await this.options.store.load();
        this.state = loaded === null ? { version: 1, licenseText: null, lastSeen: 0, sequences: [] } : validateStoredState(loaded);
      }
      const now = (this.options.now?.() ?? new Date()).getTime();
      if (!Number.isSafeInteger(now) || now < 0) throw new LicenseError("CLOCK_INVALID", "System clock is invalid");
      if (now + CLOCK_TOLERANCE_MS < this.state.lastSeen) {
        return { state: "clock-rollback", machineCode, error: "CLOCK_ROLLBACK" };
      }
      const licenseText = candidate ?? this.state.licenseText;
      let status: LicenseStatus = { state: "inactive", machineCode };
      let sequences = this.state.sequences;
      if (licenseText !== null) {
        const { claims } = readVerifiedLicense({
          publicKeyPem: this.options.publicKeyPem!, licenseText, expectedProductId: LICENSE_PRODUCT_ID,
          deviceComponentHashes: hashes as unknown as Record<string, string>,
        });
        // Production licenses bind both exact components. The standalone verifier retains legacy n-of-m support.
        if (claims.device_match_min !== 2 || Object.keys(claims.device_component_hashes).length !== 2
            || !Object.hasOwn(claims.device_component_hashes, "machine_guid") || !Object.hasOwn(claims.device_component_hashes, "smbios_uuid")) {
          throw new LicenseError("DEVICE_BINDING_INVALID", "This product requires both device components");
        }
        const claimsHash = canonicalClaimsHash(claims);
        const previous = sequences.find((item) => item.licenseId === claims.license_id);
        if (previous && (claims.sequence < previous.sequence || (claims.sequence === previous.sequence && claimsHash !== previous.claimsHash))) {
          throw new LicenseError("SEQUENCE_ROLLBACK", "License sequence must increase when the license changes");
        }
        if (candidate !== undefined) {
          if (!previous && sequences.length >= 128) throw new LicenseError("LICENSE_HISTORY_FULL", "License history is full");
          sequences = [...sequences.filter((item) => item.licenseId !== claims.license_id), { licenseId: claims.license_id, sequence: claims.sequence, claimsHash }];
        }
        status = { ...statusForClaims(claims, Math.max(now, this.state.lastSeen)), machineCode };
      }
      const next: StoredLicenseState = { version: 1, licenseText, lastSeen: Math.max(this.state.lastSeen, now), sequences };
      // Do not grant access when protected persistence fails; save first, then publish the new state.
      if (candidate !== undefined || next.lastSeen !== this.state.lastSeen) await this.options.store.save(next);
      this.state = next;
      return status;
    } catch (error) {
      const code = error instanceof LicenseError ? error.code : "LICENSE_STORAGE_UNAVAILABLE";
      return {
        state: code === "DEVICE_UNAVAILABLE" ? "device-unavailable" : code === "DEVICE_MISMATCH" ? "device-mismatch" : "invalid",
        machineCode, error: code,
      };
    }
  }
}
