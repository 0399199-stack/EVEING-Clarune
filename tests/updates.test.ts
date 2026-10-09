import { describe, expect, it, vi } from "vitest";
import { compareVersions, findUpdate, UpdateService } from "../src/main/updates";

const asset = (version: string) => ({ name: `EVEING-Clarune-${version}-Full-x64-Setup.exe`, state: "uploaded", size: 1200 });
const release = (version: string, prerelease = false) => ({ tag_name: `v${version}`, draft: false, prerelease, assets: [asset(version)] });

describe("GitHub update selection", () => {
  it("compares stable and prerelease versions", () => {
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0-rc.2")).toBeGreaterThan(0);
    expect(compareVersions("1.1.0", "1.0.9")).toBeGreaterThan(0);
    expect(compareVersions("invalid", "1.0.0")).toBeNull();
  });

  it("chooses the newest eligible release with a full installer", () => {
    const result = findUpdate([release("1.0.0"), release("1.0.0-rc.2", true), release("1.1.0")], "1.0.0-rc.1");
    expect(result).toEqual({ version: "1.1.0", url: "https://github.com/0399199-stack/EVEING-Clarune/releases/download/v1.1.0/EVEING-Clarune-1.1.0-Full-x64-Setup.exe" });
    expect(findUpdate([release("1.1.0-rc.1", true)], "1.0.0")).toBeNull();
  });

  it("rejects draft, missing, ambiguous and oversized assets", () => {
    expect(findUpdate([{ ...release("2.0.0"), draft: true }], "1.0.0")).toBeNull();
    expect(findUpdate([{ ...release("2.0.0"), assets: [] }], "1.0.0")).toBeNull();
    expect(findUpdate([{ ...release("2.0.0"), assets: [asset("2.0.0"), asset("2.0.0")] }], "1.0.0")).toBeNull();
    expect(findUpdate([{ ...release("2.0.0"), assets: [{ ...asset("2.0.0"), size: 2 * 1024 ** 3 }] }], "1.0.0")).toBeNull();
  });

  it("accepts a single installer revision but not a similar filename", () => {
    const revised = { ...asset("1.0.1"), name: "EVEING-Clarune-1.0.1-Full-x64-Setup-fix2.exe" };
    expect(findUpdate([{ ...release("1.0.1"), assets: [revised] }], "1.0.0")?.version).toBe("1.0.1");
    expect(findUpdate([{ ...release("1.0.1"), assets: [{ ...revised, name: revised.name + ".txt" }] }], "1.0.0")).toBeNull();
  });

  it("does not offer a download if the check fails or no release exists", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [release("1.1.0")] })
      .mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, json: async () => [] });
    const service = new UpdateService(fetcher as unknown as typeof fetch);
    expect(await service.check("1.0.0")).toEqual({ state: "available", version: "1.1.0" });
    expect(service.getDownloadUrl()).toContain("/releases/download/v1.1.0/");
    expect(await service.check("1.0.0")).toEqual({ state: "error" });
    expect(service.getDownloadUrl()).toBeNull();
    expect(await service.check("1.0.0")).toEqual({ state: "no-release" });
  });
});
