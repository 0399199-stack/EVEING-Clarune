import { describe, expect, it } from "vitest";
import { getWindowsDeviceHashes, hashDeviceIdentifier, normalizeDeviceIdentifier } from "../src/main/license/device";

const machine = "ed137280-c3c1-4d28-9ca7-ec1930123456";
const smbios = "873652fa-cc13-4e28-9e45-38ca20241234";

describe("privacy-preserving Windows machine binding", () => {
  it("normalizes common UUID representations and domain separates components", () => {
    expect(normalizeDeviceIdentifier(` {${machine.toUpperCase()}} `)).toBe(machine);
    expect(normalizeDeviceIdentifier(machine.replaceAll("-", ""))).toBe(machine);
    expect(hashDeviceIdentifier("machine_guid", machine)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashDeviceIdentifier("machine_guid", machine)).not.toBe(hashDeviceIdentifier("smbios_uuid", machine));
  });

  it("rejects absent, placeholder, or default hardware identifiers", () => {
    for (const value of ["", "To Be Filled By O.E.M.", "00000000-0000-0000-0000-000000000000", "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", "03000200-0400-0500-0006-000700080009", "not a uuid"])
      expect(() => normalizeDeviceIdentifier(value)).toThrowError(expect.objectContaining({ code: "DEVICE_UNAVAILABLE" }));
  });

  it.skipIf(process.platform !== "win32")("uses explicit 64-bit registry and noninteractive CIM without returning raw identifiers", async () => {
    const commands: Array<{ file: string; args: string[] }> = [];
    const hashes = await getWindowsDeviceHashes(async (file, args) => {
      commands.push({ file, args });
      return file.endsWith("reg.exe") ? `HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ${machine}\r\n` : `\uFEFF${smbios}\r\n`;
    });
    expect(commands[0].args).toContain("/reg:64");
    expect(commands[1].args).toContain("-NonInteractive");
    expect(commands[1].args).toContain("-NoProfile");
    expect(commands[1].args.at(-1)).toContain("Win32_ComputerSystemProduct");
    expect(hashes).toEqual({ machine_guid: hashDeviceIdentifier("machine_guid", machine), smbios_uuid: hashDeviceIdentifier("smbios_uuid", smbios) });
    expect(JSON.stringify(hashes)).not.toContain(machine);
    expect(JSON.stringify(hashes)).not.toContain(smbios);
  });

  it.skipIf(process.platform !== "win32")("does not disclose hardware output through errors", async () => {
    await expect(getWindowsDeviceHashes(async () => { throw new Error(machine); })).rejects.toMatchObject({ code: "DEVICE_UNAVAILABLE" });
    await expect(getWindowsDeviceHashes(async () => smbios)).rejects.not.toThrow(machine);
  });
});
