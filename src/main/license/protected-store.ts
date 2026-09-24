import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LicenseStateStore, StoredLicenseState } from "./license-service";
import { LicenseError } from "./verify-license";

export interface LicenseEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export function createProtectedLicenseStore(filePath: string, encryption: LicenseEncryption): LicenseStateStore {
  function requireEncryption(): void {
    if (!encryption.isEncryptionAvailable()) throw new LicenseError("LICENSE_STORAGE_UNAVAILABLE", "Windows protected storage is unavailable");
  }
  return {
    async load(): Promise<unknown | null> {
      requireEncryption();
      try {
        if ((await stat(filePath)).size > 256 * 1024) throw new LicenseError("STORAGE_INVALID", "Stored activation is too large");
        return JSON.parse(encryption.decryptString(await readFile(filePath)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new LicenseError("STORAGE_INVALID", "Stored activation could not be decrypted");
      }
    },
    async save(state: StoredLicenseState): Promise<void> {
      requireEncryption();
      const encrypted = encryption.encryptString(JSON.stringify(state));
      await mkdir(dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, encrypted, { flag: "wx", mode: 0o600 });
        await rename(temporaryPath, filePath);
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    },
  };
}
