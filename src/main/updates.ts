import type { UpdateStatus } from "../shared/updates";
import { UPDATE_REPOSITORY } from "../shared/updates";

interface ReleaseAsset { name?: unknown; state?: unknown; size?: unknown }
interface Release { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown }
interface Version { parts: number[]; pre: string[] }

function parseVersion(value: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  return match ? { parts: match.slice(1, 4).map(Number), pre: match[4]?.split(".") ?? [] } : null;
}

export function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) if (a.parts[i] !== b.parts[i]) return Math.sign(a.parts[i] - b.parts[i]);
  if (!a.pre.length || !b.pre.length) return Math.sign(b.pre.length - a.pre.length);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return -1;
    if (b.pre[i] === undefined) return 1;
    if (a.pre[i] === b.pre[i]) continue;
    const numericA = /^\d+$/.test(a.pre[i]), numericB = /^\d+$/.test(b.pre[i]);
    if (numericA && numericB) return Math.sign(Number(a.pre[i]) - Number(b.pre[i]));
    if (numericA !== numericB) return numericA ? -1 : 1;
    return a.pre[i] < b.pre[i] ? -1 : 1;
  }
  return 0;
}

export function findUpdate(releases: unknown, currentVersion: string): { version: string; url: string } | null {
  if (!Array.isArray(releases) || !parseVersion(currentVersion)) return null;
  const allowPrerelease = parseVersion(currentVersion)!.pre.length > 0;
  let selected: { version: string; url: string } | null = null;
  for (const item of releases as Release[]) {
    if (!item || item.draft || (item.prerelease && !allowPrerelease) || typeof item.tag_name !== "string" || !Array.isArray(item.assets)) continue;
    const version = item.tag_name.replace(/^v/, "");
    if (!parseVersion(version) || compareVersions(version, currentVersion)! <= 0 || (selected && compareVersions(version, selected.version)! <= 0)) continue;
    const prefix = `EVEING-Clarune-${version}-Full-x64-Setup`;
    const assets = (item.assets as ReleaseAsset[]).filter(asset => asset && typeof asset.name === "string"
      && asset.name.startsWith(prefix) && (asset.name.slice(prefix.length) === ".exe" || /^-fix\d+\.exe$/.test(asset.name.slice(prefix.length)))
      && asset.state === "uploaded" && typeof asset.size === "number" && asset.size > 0 && asset.size < 2 * 1024 ** 3);
    if (assets.length !== 1) continue;
    selected = { version, url: `https://github.com/${UPDATE_REPOSITORY}/releases/download/${encodeURIComponent(item.tag_name)}/${encodeURIComponent(assets[0].name as string)}` };
  }
  return selected;
}

export class UpdateService {
  private downloadUrl: string | null = null;
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async check(currentVersion: string): Promise<UpdateStatus> {
    this.downloadUrl = null;
    try {
      const response = await this.fetcher(`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=20`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": `EVEING-Clarune/${currentVersion}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return { state: "error" };
      const releases: unknown = await response.json();
      if (!Array.isArray(releases)) return { state: "error" };
      const update = findUpdate(releases, currentVersion);
      if (update) {
        this.downloadUrl = update.url;
        return { state: "available", version: update.version };
      }
      return { state: releases.length ? "current" : "no-release" };
    } catch {
      return { state: "error" };
    }
  }

  getDownloadUrl(): string | null { return this.downloadUrl; }
}
