import { describe, expect, it } from "vitest";
import { LicenseService, type StoredLicenseState } from "../src/main/license/license-service";
import { hashDeviceIdentifier } from "../src/main/license/device";

// Exercise the actual administrator tool module, not a duplicated test signer.
const issuerUrl = new URL("../../EVEING_License_Desk/license-issuer.mjs", import.meta.url).href;
const issuer = await import(/* @vite-ignore */ issuerUrl);
const passphrase = "Ephemeral test passphrase only";
const keys = issuer.generateKeys(passphrase);
const device = {
  machine_guid: hashDeviceIdentifier("machine_guid", "ed137280-c3c1-4d28-9ca7-ec1930123456"),
  smbios_uuid: hashDeviceIdentifier("smbios_uuid", "873652fa-cc13-4e28-9e45-38ca20241234"),
};

function setup() {
  let state: StoredLicenseState | null = null;
  const dependencies = {
    publicKeyPem: keys.publicKeyPem,
    getDevice: async () => device,
    now: () => new Date("2026-09-17T00:00:00.000Z"),
    store: { load: async () => state, save: async (value: StoredLicenseState) => { state = structuredClone(value); } },
  };
  return { service: new LicenseService(dependencies), restart: () => new LicenseService(dependencies) };
}

describe("administrator issuer and production activation service interoperability", () => {
  it("accepts its real machine request, signs finite license, renews it to permanent, and rejects an old token after restart", async () => {
    const { service, restart } = setup();
    const request = (await service.getStatus()).machineCode;
    const hashes = issuer.parseDeviceRequest(request);
    expect(hashes).toEqual(device);
    expect(issuer.makeDeviceRequest(hashes)).toBe(request);
    const claims = {
      product_id: "eveing-clarune", license_id: "LIC-INTEROP-001", not_before: "2026-09-16T00:00:00.000Z",
      expires_at: "2027-09-16T00:00:00.000Z", sequence: 1, device_match_min: 2, device_component_hashes: hashes,
    };
    const issued = issuer.issueLicense(keys.privateKeyPem, passphrase, claims);
    const token = issuer.licenseToken(issued);
    expect(await service.activate(token)).toMatchObject({ state: "active", expiresAt: claims.expires_at });
    expect(issuer.readIssuedLicense(token, keys.publicKeyPem)).toEqual(claims);
    const renewal = issuer.licenseToken(issuer.issueLicense(keys.privateKeyPem, passphrase, { ...claims, sequence: 2, expires_at: null }));
    expect(await service.activate(renewal)).toMatchObject({ state: "active", expiresAt: null });
    const restarted = restart();
    expect(await restarted.activate(token)).toMatchObject({ state: "invalid", error: "SEQUENCE_ROLLBACK" });
    expect(await restarted.getStatus()).toMatchObject({ state: "active", expiresAt: null });
  });

  it("rejects an authentic issuer token for a different machine", async () => {
    const { service } = setup();
    const claims = {
      product_id: "eveing-clarune", license_id: "LIC-OTHER-DEVICE", not_before: "2026-09-16T00:00:00.000Z",
      expires_at: null, sequence: 1, device_match_min: 2,
      device_component_hashes: { ...device, machine_guid: "b".repeat(64) },
    };
    const token = issuer.licenseToken(issuer.issueLicense(keys.privateKeyPem, passphrase, claims));
    expect(await service.activate(token)).toMatchObject({ state: "device-mismatch", error: "DEVICE_MISMATCH" });
  });
});
