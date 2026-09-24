import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProtectedLicenseStore, type LicenseEncryption } from "../src/main/license/protected-store";
import type { StoredLicenseState } from "../src/main/license/license-service";

const folders: string[] = [];
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "clarune-license-store-"));
  folders.push(folder);
  return { folder, file: join(folder, "activation-state.bin") };
}
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { force: true, recursive: true });
});

const state: StoredLicenseState = { version: 1, licenseText: "SECRET_TOKEN", lastSeen: 123, sequences: [] };
// A deterministic stand-in proves the storage boundary; production injects Electron safeStorage (Windows DPAPI).
const encryption: LicenseEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 0xff)),
  decryptString: (value) => Buffer.from(value.map((byte) => byte ^ 0xff)).toString(),
};

describe("protected atomic activation storage", () => {
  it("writes encrypted bytes atomically and reopens the persisted state", async () => {
    const { folder, file } = await fixture();
    const store = createProtectedLicenseStore(file, encryption);
    expect(await store.load()).toBeNull();
    await store.save(state);
    expect((await readFile(file)).toString()).not.toContain("SECRET_TOKEN");
    expect(await store.load()).toEqual(state);
    await store.save({ ...state, lastSeen: 456 });
    expect(await store.load()).toEqual({ ...state, lastSeen: 456 });
    expect(await readdir(folder)).toEqual(["activation-state.bin"]);
  });

  it("refuses plaintext fallback when safeStorage is unavailable", async () => {
    const { folder, file } = await fixture();
    const unavailable = createProtectedLicenseStore(file, { ...encryption, isEncryptionAvailable: () => false });
    await expect(unavailable.load()).rejects.toMatchObject({ code: "LICENSE_STORAGE_UNAVAILABLE" });
    await expect(unavailable.save(state)).rejects.toMatchObject({ code: "LICENSE_STORAGE_UNAVAILABLE" });
    expect(await readdir(folder)).toEqual([]);
  });

  it("does not overwrite a prior activation when encryption fails", async () => {
    const { file } = await fixture();
    const working = createProtectedLicenseStore(file, encryption);
    await working.save(state);
    const broken = createProtectedLicenseStore(file, { ...encryption, encryptString: () => { throw new Error("DPAPI unavailable"); } });
    await expect(broken.save({ ...state, lastSeen: 456 })).rejects.toThrow("DPAPI unavailable");
    expect(await working.load()).toEqual(state);
  });

  it("rejects corrupted or oversized protected files without deleting them", async () => {
    const { file } = await fixture();
    const store = createProtectedLicenseStore(file, encryption);
    await writeFile(file, Buffer.from("not encrypted"));
    await expect(store.load()).rejects.toMatchObject({ code: "STORAGE_INVALID" });
    expect((await readFile(file)).toString()).toBe("not encrypted");
    await writeFile(file, Buffer.alloc(256 * 1024 + 1));
    await expect(store.load()).rejects.toMatchObject({ code: "STORAGE_INVALID" });
  });
});
