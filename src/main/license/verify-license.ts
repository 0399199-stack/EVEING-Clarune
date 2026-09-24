import { createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { LICENSE_TOKEN_PREFIX, MAX_LICENSE_TEXT_LENGTH } from "../../shared/license";

export interface LicenseClaims {
  product_id: string;
  license_id: string;
  not_before: string;
  expires_at: string | null;
  sequence: number;
  device_match_min: number;
  device_component_hashes: Record<string, string>;
}

export interface VerifyLicenseOptions {
  publicKeyPem: string;
  licenseText: string;
  expectedProductId: string;
  deviceComponentHashes: Record<string, string>;
  now?: Date;
  minimumSequence?: number;
}

export interface VerifiedLicense {
  claims: LicenseClaims;
  matchedComponents: string[];
}

export class LicenseError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "LicenseError";
  }
}

function reject(code: string, message: string): never {
  throw new LicenseError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeBase64Url(value: unknown, field: string): Buffer {
  if (typeof value !== "string" || value.length > MAX_LICENSE_TEXT_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    reject("LICENSE_FORMAT_INVALID", `${field} must be base64url`);
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) reject("LICENSE_FORMAT_INVALID", `${field} must be canonical base64url`);
  return bytes;
}

function parseDate(value: unknown, field: string): number {
  const milliseconds = typeof value === "string" ? Date.parse(value) : NaN;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      || !Number.isFinite(milliseconds) || milliseconds < 0 || new Date(milliseconds).toISOString() !== value) {
    reject("CLAIMS_INVALID", `${field} must be a canonical ISO-8601 instant`);
  }
  return milliseconds;
}

function parseClaims(value: unknown): {
  claims: LicenseClaims;
  notBefore: number;
  expiresAt: number | null;
} {
  if (!isRecord(value)) reject("CLAIMS_INVALID", "signed payload must be an object");
  const claims = value as unknown as LicenseClaims;
  if (typeof claims.product_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(claims.product_id)
      || typeof claims.license_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(claims.license_id)
      || !Number.isSafeInteger(claims.sequence) || claims.sequence < 1
      || !isRecord(claims.device_component_hashes)) {
    reject("CLAIMS_INVALID", "required license claims are invalid");
  }
  const components = Object.entries(claims.device_component_hashes);
  if (!components.length || components.length > 8
      || components.some(([name, hash]) => !/^[a-z][a-z0-9_]{0,63}$/.test(name) || typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash))
      || !Number.isSafeInteger(claims.device_match_min)
      || claims.device_match_min < 1
      || claims.device_match_min > components.length) {
    reject("CLAIMS_INVALID", "device binding claims are invalid");
  }
  const notBefore = parseDate(claims.not_before, "not_before");
  const expiresAt = claims.expires_at === null ? null : parseDate(claims.expires_at, "expires_at");
  if (expiresAt !== null && notBefore >= expiresAt) reject("CLAIMS_INVALID", "expiry must follow activation");
  return { claims, notBefore, expiresAt };
}

function hashesMatch(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string" || !/^[a-f0-9]{64}$/i.test(actual)) return false;
  return timingSafeEqual(
    Buffer.from(expected.toLowerCase(), "ascii"),
    Buffer.from(actual.toLowerCase(), "ascii"),
  );
}

export function readVerifiedLicense(options: VerifyLicenseOptions): VerifiedLicense {
  if (typeof options.licenseText !== "string" || options.licenseText.length > MAX_LICENSE_TEXT_LENGTH) {
    reject("LICENSE_FORMAT_INVALID", "license is too large or invalid");
  }
  let licenseText = options.licenseText.trim();
  if (licenseText.startsWith(LICENSE_TOKEN_PREFIX)) {
    licenseText = decodeBase64Url(licenseText.slice(LICENSE_TOKEN_PREFIX.length), "license").toString("utf8");
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(licenseText);
  } catch {
    reject("LICENSE_FORMAT_INVALID", "license must be JSON");
  }
  if (!isRecord(envelope) || envelope.version !== 1 || envelope.alg !== "Ed25519") {
    reject("LICENSE_FORMAT_INVALID", "unsupported license envelope");
  }

  const payloadBytes = decodeBase64Url(envelope.payload, "payload");
  const signatureBytes = decodeBase64Url(envelope.signature, "signature");
  if (signatureBytes.length !== 64) reject("SIGNATURE_INVALID", "license signature is invalid");
  let validSignature = false;
  try {
    const publicKey = createPublicKey(options.publicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519") reject("SIGNATURE_INVALID", "license verification key must be Ed25519");
    validSignature = verify(null, payloadBytes, publicKey, signatureBytes);
  } catch {
    reject("SIGNATURE_INVALID", "license signature is invalid");
  }
  if (!validSignature) {
    reject("SIGNATURE_INVALID", "license signature is invalid");
  }

  let signedValue: unknown;
  try {
    signedValue = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    reject("CLAIMS_INVALID", "signed payload must be JSON");
  }
  const { claims } = parseClaims(signedValue);
  if (claims.product_id !== options.expectedProductId) {
    reject("PRODUCT_MISMATCH", "license is for another product");
  }
  const minimumSequence = options.minimumSequence ?? 1;
  if (!Number.isSafeInteger(minimumSequence) || minimumSequence < 1) {
    throw new TypeError("minimumSequence must be a positive integer");
  }
  if (claims.sequence < minimumSequence) {
    reject("SEQUENCE_ROLLBACK", "license sequence is older than the stored sequence");
  }

  const matchedComponents = Object.entries(claims.device_component_hashes)
    .filter(([name, expected]) => hashesMatch(expected, options.deviceComponentHashes[name]))
    .map(([name]) => name);
  if (matchedComponents.length < claims.device_match_min) {
    reject("DEVICE_MISMATCH", "not enough device components match");
  }
  return { claims, matchedComponents };
}

export function verifyLicense(options: VerifyLicenseOptions): VerifiedLicense {
  const result = readVerifiedLicense(options);
  const now = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(now)) throw new TypeError("now must be a valid Date");
  if (now < Date.parse(result.claims.not_before)) reject("LICENSE_NOT_YET_VALID", "license is not active yet");
  if (result.claims.expires_at !== null && now >= Date.parse(result.claims.expires_at)) reject("LICENSE_EXPIRED", "license has expired");
  return result;
}
