import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { UpscaleStatus } from "../../shared/image-tools";
import { ImageToolError } from "../image-tools/errors";
import { probeRealHat, type RealHatRuntime } from "./realhat-process";
import { checkUpscaleCanceled } from "./native-process";

export const REALHAT_WEIGHT_SHA256 = "f5b1e3bbbb05147ca2beefcc715279cb647d7976cbda67d62ea7e6e20d5ffcc7";
const VERSION = "Real-HAT x4 · PyTorch CUDA · local";
let registryPath: string | undefined, runtimeRoot: string | undefined, worker: string | undefined;
let source: "selected" | "detected" | undefined;
let loaded: Promise<void> = Promise.resolve();
let probeCache: { key: string; expires: number; pending: Promise<void> } | undefined;
let probeLifecycle = { abort: new AbortController(), pending: new Set<Promise<void>>() };

/** Stop capability checks only; an already-running batch may still finish inference. */
export function stopRealHatProbes(): Promise<void> | null {
  probeLifecycle.abort.abort();
  return probeLifecycle.pending.size ? Promise.allSettled([...probeLifecycle.pending]).then(() => undefined) : null;
}

export function configureRealHatRuntime(path: string, workerPath: string, candidates: string[] = []): void {
  void stopRealHatProbes();
  probeLifecycle = { abort: new AbortController(), pending: new Set<Promise<void>>() };
  registryPath = path; worker = workerPath; runtimeRoot = undefined; source = undefined; probeCache = undefined;
  loaded = readFile(path).then((bytes) => {
    if (bytes.length > 16_384) return;
    const entry: unknown = JSON.parse(bytes.toString("utf8"));
    if (entry && typeof entry === "object" && "directory" in entry && typeof entry.directory === "string" && isAbsolute(entry.directory)) { runtimeRoot = entry.directory; source = "selected"; }
  }).catch(async (error: NodeJS.ErrnoException) => {
    // Existing but corrupt/invalid explicit selection never falls back elsewhere.
    if (error.code !== "ENOENT") return;
    for (const directory of candidates) {
      try { await verifyRealHatRuntime(directory, false); runtimeRoot = directory; source = "detected"; return; }
      catch { /* Consider only the exact local candidate supplied by main. */ }
    }
  });
}

/** Weights are pinned on every status/launch; the interpreter is explicitly selected, not downloaded. */
export async function verifyRealHatRuntime(directory: string, probe = true): Promise<RealHatRuntime> {
  const lifecycle = probeLifecycle;
  try {
    if (probe) checkUpscaleCanceled(lifecycle.abort.signal);
    if (process.platform !== "win32" || !isAbsolute(directory) || !(await lstat(directory)).isDirectory() || !worker || !isAbsolute(worker)) throw new Error("Invalid runtime directory");
    const manifestPath = join(directory, "clarune-realhat.json");
    const manifestStat = await lstat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.size > 16_384) throw new Error("Invalid manifest");
    const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || !("pythonExecutable" in manifest) || typeof manifest.pythonExecutable !== "string" || !/\.exe$/i.test(manifest.pythonExecutable)) throw new Error("Invalid interpreter");
    const bundledPython = manifest.pythonExecutable === "./python/python.exe";
    if (!bundledPython && !isAbsolute(manifest.pythonExecutable)) throw new Error("Invalid interpreter");
    const pythonExecutable = bundledPython ? join(directory, "python", "python.exe") : resolve(manifest.pythonExecutable), weight = join(directory, "models", "Real_HAT_GAN_SRx4.pth");
    const [pythonStat, workerStat, weightStat] = await Promise.all([lstat(pythonExecutable), lstat(worker), lstat(weight)]);
    if (!pythonStat.isFile() || !workerStat.isFile() || !weightStat.isFile() || weightStat.size !== 170_277_017) throw new Error("Missing runtime file");
    if (createHash("sha256").update(await readFile(weight)).digest("hex") !== REALHAT_WEIGHT_SHA256) throw new Error("Untrusted checkpoint");
    const runtime = { pythonExecutable, worker, weight };
    if (probe) {
      // Closing while manifest/weight reads are pending must never start Python later.
      checkUpscaleCanceled(lifecycle.abort.signal);
      const key = JSON.stringify([pythonExecutable, pythonStat.size, pythonStat.mtimeMs, worker, workerStat.size, workerStat.mtimeMs]);
      if (!probeCache || probeCache.key !== key || Date.now() >= probeCache.expires) {
        const cache = { key, expires: Date.now() + 5 * 60_000, pending: probeRealHat(runtime, { signal: lifecycle.abort.signal }) };
        lifecycle.pending.add(cache.pending);
        // Failed probes may be retried soon after the user repairs their external environment.
        void cache.pending.then(() => { lifecycle.pending.delete(cache.pending); }, () => { lifecycle.pending.delete(cache.pending); cache.expires = Date.now() + 5_000; });
        probeCache = cache;
      }
      await probeCache.pending;
      checkUpscaleCanceled(lifecycle.abort.signal);
    }
    return runtime;
  } catch (error) {
    if (error instanceof ImageToolError) throw error;
    throw new ImageToolError("REALHAT_RUNTIME_UNVERIFIED");
  }
}

export async function getRealHatRuntime(probe = false): Promise<RealHatRuntime> {
  await loaded;
  if (!runtimeRoot) throw new ImageToolError("REALHAT_RUNTIME_NOT_CONFIGURED");
  return verifyRealHatRuntime(runtimeRoot, probe);
}

export async function getRealHatStatus(): Promise<UpscaleStatus> {
  try { await getRealHatRuntime(true); return { ready: true, localOnly: true, runtimeVersion: VERSION, source }; }
  catch (error) { return { ready: false, localOnly: true, reason: error instanceof ImageToolError ? error.message : "REALHAT_RUNTIME_UNVERIFIED" }; }
}

export async function selectRealHatRuntime(directory: string): Promise<UpscaleStatus> {
  await loaded;
  await verifyRealHatRuntime(directory);
  if (!registryPath) throw new ImageToolError("REALHAT_RUNTIME_NOT_CONFIGURED");
  const temporary = `${registryPath}.tmp`;
  try {
    await mkdir(dirname(registryPath), { recursive: true });
    await writeFile(temporary, JSON.stringify({ directory: resolve(directory), localOnly: true }), { mode: 0o600 });
    await rename(temporary, registryPath);
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new ImageToolError("UPSCALE_RUNTIME_SAVE_FAILED");
  }
  runtimeRoot = resolve(directory); source = "selected";
  return { ready: true, localOnly: true, runtimeVersion: VERSION, source };
}
