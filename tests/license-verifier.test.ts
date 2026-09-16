import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyLicense } from "../src/main/license/verify-license";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const deviceComponentHashes = {
  machine_guid: hash("machine"),
  smbios_uuid: hash("motherboard"),
  system_drive: hash("drive"),
};

function claims(overrides: Record<string, unknown> = {}) {
  return {
    product_id: "com.eveing.clarune",
    license_id: "LIC-TEST-001",
    not_before: "2026-09-16T00:00:00.000Z",
    expires_at: "2027-09-16T00:00:00.000Z",
    sequence: 1,
    device_match_min: 2,
    device_component_hashes: deviceComponentHashes,
    ...overrides,
  };
}

function issue(value = claims()): string {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  return JSON.stringify({
    version: 1,
    alg: "Ed25519",
    payload: payload.toString("base64url"),
    signature: sign(null, payload, privateKey).toString("base64url"),
  });
}

function check(licenseText: string, overrides: Partial<Parameters<typeof verifyLicense>[0]> = {}) {
  return verifyLicense({
    publicKeyPem,
    licenseText,
    expectedProductId: "com.eveing.clarune",
    deviceComponentHashes,
    now: new Date("2026-10-01T00:00:00.000Z"),
    ...overrides,
  });
}

describe("offline license verifier", () => {
  it("accepts a valid signature and 2-of-3 device match", () => {
    const actual = { ...deviceComponentHashes, system_drive: hash("replacement") };
    const result = check(issue(), { deviceComponentHashes: actual });
    expect(result.claims.license_id).toBe("LIC-TEST-001");
    expect(result.matchedComponents).toEqual(["machine_guid", "smbios_uuid"]);
  });

  it("rejects an edited expiry without the private key", () => {
    const envelope = JSON.parse(issue());
    const value = claims({ expires_at: "2099-01-01T00:00:00.000Z" });
    envelope.payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    expect(() => check(JSON.stringify(envelope))).toThrowError(
      expect.objectContaining({ code: "SIGNATURE_INVALID" }),
    );
  });

  it("rejects a license at its exact expiry instant", () => {
    expect(() => check(issue(), { now: new Date("2027-09-16T00:00:00.000Z") }))
      .toThrowError(expect.objectContaining({ code: "LICENSE_EXPIRED" }));
  });

  it("rejects a license before its activation instant", () => {
    expect(() => check(issue(), { now: new Date("2026-09-15T23:59:59.999Z") }))
      .toThrowError(expect.objectContaining({ code: "LICENSE_NOT_YET_VALID" }));
  });

  it("rejects mismatched product and device identifiers", () => {
    expect(() => check(issue(), { expectedProductId: "another.product" }))
      .toThrowError(expect.objectContaining({ code: "PRODUCT_MISMATCH" }));
    expect(() => check(issue(), { deviceComponentHashes: { machine_guid: deviceComponentHashes.machine_guid } }))
      .toThrowError(expect.objectContaining({ code: "DEVICE_MISMATCH" }));
  });

  it("rejects a lower sequence after renewal", () => {
    expect(() => check(issue(), { minimumSequence: 2 }))
      .toThrowError(expect.objectContaining({ code: "SEQUENCE_ROLLBACK" }));
    const renewed = issue(claims({ sequence: 2, expires_at: "2028-09-16T00:00:00.000Z" }));
    expect(check(renewed, { minimumSequence: 2 }).claims.sequence).toBe(2);
  });
});
