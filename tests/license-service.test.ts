import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LICENSE_PRODUCT_ID, LICENSE_TOKEN_PREFIX, type DeviceComponentHashes } from "../src/shared/license";
import { LicenseService, type LicenseStateStore, type StoredLicenseState } from "../src/main/license/license-service";
import { LicenseError } from "../src/main/license/verify-license";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const device: DeviceComponentHashes = { machine_guid: hash("machine"), smbios_uuid: hash("smbios") };
const now = new Date("2026-09-17T00:00:00.000Z");

function issue(overrides: Record<string, unknown> = {}, encoded = true): string {
  const payload = Buffer.from(JSON.stringify({
    product_id: LICENSE_PRODUCT_ID, license_id: "LIC-001", not_before: "2026-09-16T00:00:00.000Z",
    expires_at: "2027-09-16T00:00:00.000Z", sequence: 1, device_match_min: 2,
    device_component_hashes: device, ...overrides,
  }));
  const envelope = JSON.stringify({ version: 1, alg: "Ed25519", payload: payload.toString("base64url"), signature: sign(null, payload, privateKey).toString("base64url") });
  return encoded ? LICENSE_TOKEN_PREFIX + Buffer.from(envelope).toString("base64url") : envelope;
}

function memoryStore(): LicenseStateStore & { state: unknown | null; writes: number } {
  return {
    state: null, writes: 0,
    async load() { return this.state === null ? null : structuredClone(this.state); },
    async save(value) { this.state = structuredClone(value); this.writes++; },
  };
}

function setup(overrides: Partial<ConstructorParameters<typeof LicenseService>[0]> = {}) {
  const store = memoryStore();
  const clock = { value: new Date(now) };
  const service = new LicenseService({ publicKeyPem, store, getDevice: async () => device, now: () => clock.value, ...overrides });
  return { service, store, clock };
}

describe("production offline activation", () => {
  it("starts inactive and generates a request containing only product-scoped hashes", async () => {
    const { service } = setup();
    const status = await service.getStatus();
    expect(status.state).toBe("inactive");
    expect(status.machineCode).toMatch(/^CLARUNE-DEVICE-1\./);
    const request = JSON.parse(Buffer.from(status.machineCode!.split(".")[1], "base64url").toString());
    expect(request).toEqual({ version: 1, product_id: LICENSE_PRODUCT_ID, device_component_hashes: device });
    await expect(service.requireActive()).rejects.toMatchObject({ code: "LICENSE_REQUIRED" });
  });

  it("accepts encoded or original v1 JSON activation and survives a restart", async () => {
    const { service, store } = setup();
    expect(await service.activate(issue())).toMatchObject({ state: "active", licenseId: "LIC-001" });
    await expect(service.requireActive()).resolves.toBeUndefined();
    const restarted = setup({ store }).service;
    expect((await restarted.getStatus()).state).toBe("active");
    expect((await restarted.activate(issue({}, false))).state).toBe("active");
  });

  it("accepts an explicitly permanent license", async () => {
    const { service, clock } = setup();
    expect(await service.activate(issue({ expires_at: null }))).toMatchObject({ state: "active", expiresAt: null });
    clock.value = new Date("2099-01-01T00:00:00.000Z");
    expect((await service.getStatus()).state).toBe("active");
  });

  it("checks not-before and the exact expiration boundary on every request", async () => {
    const { service, clock } = setup();
    const notBefore = "2026-09-18T00:00:00.000Z";
    expect(await service.activate(issue({ not_before: notBefore }))).toMatchObject({ state: "not-yet-valid", notBefore });
    await expect(service.requireActive()).rejects.toMatchObject({ code: "LICENSE_REQUIRED" });
    clock.value = new Date(notBefore);
    expect((await service.getStatus()).state).toBe("active");
    clock.value = new Date("2027-09-16T00:00:00.000Z");
    expect((await service.getStatus()).state).toBe("expired");
  });

  it("rejects a tampered expiry and keeps a previously valid license intact", async () => {
    const { service, store } = setup();
    await service.activate(issue());
    const before = structuredClone(store.state);
    const edited = JSON.parse(issue({}, false));
    const claims = JSON.parse(Buffer.from(edited.payload, "base64url").toString());
    claims.expires_at = null;
    edited.payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    expect(await service.activate(JSON.stringify(edited))).toMatchObject({ state: "invalid", error: "SIGNATURE_INVALID" });
    expect(store.state).toEqual(before);
    expect((await service.getStatus()).state).toBe("active");
  });

  it("rejects other products and a change to either required device component", async () => {
    const { service } = setup();
    expect(await service.activate(issue({ product_id: "other-product" }))).toMatchObject({ state: "invalid", error: "PRODUCT_MISMATCH" });
    for (const name of ["machine_guid", "smbios_uuid"] as const) {
      expect(await service.activate(issue({ device_component_hashes: { ...device, [name]: hash("another") } })))
        .toMatchObject({ state: "device-mismatch", error: "DEVICE_MISMATCH" });
    }
  });

  it("does not accept a correctly signed weaker device policy", async () => {
    const { service } = setup();
    expect(await service.activate(issue({ device_match_min: 1 }))).toMatchObject({ state: "invalid", error: "DEVICE_BINDING_INVALID" });
    expect(await service.activate(issue({ device_component_hashes: { ...device, extra: hash("extra") } })))
      .toMatchObject({ state: "invalid", error: "DEVICE_BINDING_INVALID" });
  });

  it("requires two usable components even for an inactive install", async () => {
    const missing = setup({ getDevice: async () => ({ machine_guid: device.machine_guid } as DeviceComponentHashes) }).service;
    expect(await missing.getStatus()).toMatchObject({ state: "device-unavailable", error: "DEVICE_UNAVAILABLE" });
    const failed = setup({ getDevice: async () => { throw new LicenseError("DEVICE_UNAVAILABLE", "raw hardware never returned"); } }).service;
    expect(await failed.activate(issue())).toEqual({ state: "device-unavailable", machineCode: undefined, error: "DEVICE_UNAVAILABLE" });
  });

  it("fails closed with a missing, invalid, or non-Ed25519 public key", async () => {
    const otherKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "pem" }).toString();
    for (const key of [null, "not-a-key", otherKey]) {
      const { service, store } = setup({ publicKeyPem: key });
      expect((await service.activate(issue())).state).toBe("unconfigured");
      expect(store.state).toBeNull();
      await expect(service.requireActive()).rejects.toMatchObject({ code: "LICENSE_REQUIRED" });
    }
  });

  it("tracks the largest observed clock across restart and never lowers it", async () => {
    const { service, store, clock } = setup();
    await service.activate(issue());
    const highWater = clock.value.getTime();
    clock.value = new Date(highWater - 4 * 60_000);
    expect((await service.getStatus()).state).toBe("active");
    expect((store.state as StoredLicenseState).lastSeen).toBe(highWater);
    const restart = setup({ store, now: () => new Date(highWater - 5 * 60_000 - 1) }).service;
    expect(await restart.getStatus()).toMatchObject({ state: "clock-rollback", error: "CLOCK_ROLLBACK" });
    expect((await restart.activate(issue({ sequence: 2 }))).state).toBe("clock-rollback");
    await expect(restart.requireActive()).rejects.toMatchObject({ code: "LICENSE_REQUIRED" });
    clock.value = new Date(highWater);
    expect((await service.getStatus()).state).toBe("active");
  });

  it("does not revive expired licenses by rolling back within clock tolerance", async () => {
    const { service, clock } = setup();
    await service.activate(issue());
    clock.value = new Date("2027-09-16T00:00:00.000Z");
    expect((await service.getStatus()).state).toBe("expired");
    clock.value = new Date("2027-09-15T23:59:00.000Z");
    expect((await service.getStatus()).state).toBe("expired");
  });

  it("persists per-license renewal sequences and disallows changed same-sequence claims", async () => {
    const { service, store } = setup();
    await service.activate(issue({ sequence: 3 }));
    await service.activate(issue({ license_id: "LIC-002" }));
    const restarted = setup({ store }).service;
    expect(await restarted.activate(issue({ sequence: 2 }))).toMatchObject({ state: "invalid", error: "SEQUENCE_ROLLBACK" });
    expect(await restarted.activate(issue({ sequence: 3, expires_at: null }))).toMatchObject({ state: "invalid", error: "SEQUENCE_ROLLBACK" });
    expect((await restarted.activate(issue({ sequence: 3 }))).state).toBe("active");
    expect((await restarted.activate(issue({ sequence: 4, expires_at: null }))).state).toBe("active");
  });

  it("serializes concurrent activation so older responses cannot overwrite renewal", async () => {
    const { service, store } = setup();
    const results = await Promise.all([service.activate(issue({ sequence: 2 })), service.activate(issue()), service.getStatus()]);
    expect(results.map((result) => result.state)).toEqual(["active", "invalid", "active"]);
    expect((store.state as StoredLicenseState).sequences[0].sequence).toBe(2);
    await service.whenIdle();
  });

  it("does not grant access or publish activation if protected storage fails", async () => {
    const store = memoryStore();
    store.save = async () => { throw new Error("disk full"); };
    const { service } = setup({ store });
    expect(await service.activate(issue())).toMatchObject({ state: "invalid", error: "LICENSE_STORAGE_UNAVAILABLE" });
    await expect(service.requireActive()).rejects.toMatchObject({ code: "LICENSE_REQUIRED" });
    expect(store.state).toBeNull();
    const broken = setup({ store: { load: async () => { throw new Error("DPAPI error"); }, save: async () => undefined } }).service;
    expect((await broken.getStatus()).state).toBe("invalid");
  });

  it("rejects malformed stored activation without replacing it", async () => {
    for (const bad of [{}, { version: 1, licenseText: null, lastSeen: -1, sequences: [] }, { version: 1, licenseText: null, lastSeen: 0, sequences: [{}] }]) {
      const store = memoryStore(); store.state = bad;
      expect(await setup({ store }).service.getStatus()).toMatchObject({ state: "invalid", error: "STORAGE_INVALID" });
      expect(store.writes).toBe(0);
    }
  });

  it("bounds malformed token, identifier, sequence, and signature input", async () => {
    const { service } = setup();
    for (const bad of ["x".repeat(16_385), "CLARUNE-LICENSE-1.@@@", "{}", issue({ license_id: "a".repeat(129) }), issue({ sequence: 0 }), issue({ sequence: 1.5 }), issue({ expires_at: "bad" })]) {
      expect((await service.activate(bad)).state).toBe("invalid");
    }
    const bad = JSON.parse(issue({}, false)); bad.signature = "YQ";
    expect(await service.activate(JSON.stringify(bad))).toMatchObject({ state: "invalid", error: "SIGNATURE_INVALID" });
  });
});
