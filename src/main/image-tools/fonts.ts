import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
let cached: Promise<string[]> | undefined;

/** Enumerates local family names only. No renderer input is ever used as shell code or a path. */
export function getSystemFonts(): Promise<string[]> {
  cached ??= (async () => {
    if (process.platform !== "win32") return ["sans-serif", "serif", "monospace"];
    const script = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Drawing; $collection=[System.Drawing.Text.InstalledFontCollection]::new(); try { @($collection.Families | ForEach-Object { $_.Name } | Sort-Object -Unique) | ConvertTo-Json -Compress } finally { $collection.Dispose() }";
    const { stdout } = await run(join(process.env.WINDIR || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" });
    const parsed: unknown = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
    const values = Array.isArray(parsed) ? parsed : [parsed];
    const fonts = [...new Set(values.filter((name): name is string => typeof name === "string" && name.length > 0 && name.length <= 200))].sort((a, b) => a.localeCompare(b));
    if (!fonts.length) throw new Error("FONT_ENUMERATION_FAILED");
    return fonts;
  })().catch((error) => { cached = undefined; throw error; });
  return cached;
}

export async function isInstalledFont(family: string): Promise<boolean> {
  return (await getSystemFonts()).some((name) => name.toLocaleLowerCase() === family.toLocaleLowerCase());
}
