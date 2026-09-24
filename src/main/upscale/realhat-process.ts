import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { ImageToolError } from "../image-tools/errors";
import { checkUpscaleCanceled, type UpscaleExecution } from "./native-process";

export interface RealHatRuntime { pythonExecutable: string; worker: string; weight: string }
const ERRORS = new Set(["REALHAT_RUNTIME_UNVERIFIED", "REALHAT_DEPENDENCIES_MISSING", "REALHAT_CUDA_UNAVAILABLE", "REALHAT_OUT_OF_MEMORY", "REALHAT_ENGINE_FAILED"]);

/** Product-owned script, isolated Python imports and a small, explicit stdout protocol. */
function runWorker(runtime: RealHatRuntime, args: string[], probe: boolean, execution: UpscaleExecution = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    checkUpscaleCanceled(execution.signal);
    let failed = false, timedOut = false, ready = false, remainder = "", reportedError = "", lastPercent = -1;
    const child = spawn(runtime.pythonExecutable, ["-I", "-B", "-u", runtime.worker, ...args], {
      cwd: dirname(runtime.worker), windowsHide: true, shell: false, stdio: ["ignore", "pipe", "ignore"],
      // In particular, never inherit PYTHONPATH, user-site, working-directory or
      // user-controlled PATH imports from the Electron launch environment.
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: join(process.env.SystemRoot || "C:\\Windows", "System32") },
    });
    const abort = () => { child.kill(); };
    execution.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, probe ? 60_000 : 20 * 60_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      const lines = (remainder + chunk.toString("utf8")).split(/[\r\n]/);
      remainder = lines.pop()!.slice(-8192);
      for (const line of lines) {
        if (!line.startsWith("CLARUNE_REALHAT ") || line.length > 8192) continue;
        try {
          const value = JSON.parse(line.slice(16));
          if (value?.type === "ready" && value.architecture === "HAT" && value.scale === 4 && value.cuda === true) ready = true;
          if (value?.type === "error" && ERRORS.has(value.code)) reportedError = value.code;
          if (!probe && value?.type === "progress" && typeof value.percent === "number" && Number.isFinite(value.percent) && value.percent >= 0 && value.percent <= 100 && value.percent > lastPercent && !execution.signal?.aborted) {
            lastPercent = value.percent;
            execution.onProgress?.({ stage: "inference", percent: value.percent });
          }
        } catch { /* Ignore library chatter and malformed/incomplete records. */ }
      }
    });
    child.once("error", () => { failed = true; });
    // Waiting for close is essential: the caller owns and removes temporary files.
    child.once("close", (code) => {
      clearTimeout(timer);
      execution.signal?.removeEventListener("abort", abort);
      if (execution.signal?.aborted) reject(new ImageToolError("CANCELED"));
      else if (timedOut) reject(new ImageToolError("UPSCALE_TIMEOUT"));
      else if (reportedError) reject(new ImageToolError(reportedError));
      else if (failed || code !== 0 || (probe && !ready)) reject(new ImageToolError("REALHAT_ENGINE_FAILED"));
      else resolve();
    });
    if (execution.signal?.aborted) abort();
  });
}

export function probeRealHat(runtime: RealHatRuntime, execution: UpscaleExecution = {}): Promise<void> {
  return runWorker(runtime, ["--probe"], true, execution);
}

export function executeRealHat(runtime: RealHatRuntime, input: string, output: string, tileSize: number, execution: UpscaleExecution = {}): Promise<void> {
  return runWorker(runtime, ["--model", runtime.weight, "--input", input, "--output", output, "--tile", String(tileSize)], false, execution);
}
