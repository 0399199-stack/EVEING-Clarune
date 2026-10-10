import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("../tools/installer/clarune.iss", import.meta.url), "utf8");
const packager = readFileSync(new URL("../tools/package-release.ps1", import.meta.url), "utf8");
const previewPackager = readFileSync(new URL("../tools/package-preview.ps1", import.meta.url), "utf8");

describe("installer directory validation source regressions", () => {
  it("only expands reviewed Inno directory constants", () => {
    const supported = new Set([
      "localappdata", "userappdata", "userdocs", "userdesktop", "win", "sys", "tmp", "app",
      "commonpf32", "commonpf64",
    ]);
    const expansions = [...script.matchAll(/ExpandConstant\('([^']+)'\)/g)];
    expect(expansions.length).toBeGreaterThan(0);
    for (const [, expression] of expansions) {
      for (const [, name] of expression.matchAll(/\{([^}]+)\}/g)) {
        expect(supported.has(name), `Unsupported installer constant: ${name}`).toBe(true);
      }
    }
  });

  it("reads USERPROFILE explicitly and fails closed if it is absent", () => {
    expect(script).toContain("Profile := GetEnv('USERPROFILE');");
    expect(script).toContain("if Profile = '' then Exit;");
    expect(script).toContain("Target = NormalPath(Profile)");
  });

  it("keeps per-user installation outside Windows and Program Files trees", () => {
    expect(script).toContain("PrivilegesRequired=lowest");
    for (const root of ["win", "commonpf32", "commonpf64"]) {
      expect(script).toContain(`Pos(AddBackslash(NormalPath(ExpandConstant('{${root}}'))), AddBackslash(Target)) = 1`);
    }
  });
});

describe("release candidate packaging regressions", () => {
  it("uses the package version in the candidate notice and preserves old installers", () => {
    expect(packager).toContain("$candidateNotice.Replace('{VERSION}', $package.version)");
    expect(packager).toContain("Refusing to overwrite an existing installer");
    expect(packager).toContain("[string]$InstallerRevision = ''");
    expect(packager).toContain("'1.0.0-rc.2'");
  });

  it("replaces only validated generated output before copying the new build", () => {
    const remove = previewPackager.indexOf("Remove-Item -LiteralPath $previewOut -Recurse -Force");
    const copy = previewPackager.indexOf("Copy-Item -LiteralPath (Join-Path $projectRoot 'out')");
    expect(remove).toBeGreaterThan(previewPackager.indexOf("Unexpected compiled application target."));
    expect(remove).toBeGreaterThan(previewPackager.indexOf("Compiled application staging is a link."));
    expect(copy).toBeGreaterThan(remove);
    expect(previewPackager).not.toMatch(/Remove-Item[^\r\n]+resources\/ai/);
  });
});
