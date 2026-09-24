import { spawn } from "node:child_process";
import { join } from "node:path";
import type { EnhancementProgress, UpscaleOptions } from "../../shared/image-tools";
import { ImageToolError } from "../image-tools/errors";

export interface UpscaleExecution {
  signal?: AbortSignal;
  onProgress?: (progress: Omit<EnhancementProgress, "id">) => void;
  timeoutMs?: number;
}

export function checkUpscaleCanceled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ImageToolError("CANCELED");
}

/** Only fixed arguments and a verified external directory reach this worker. */
export function executeUpscale(directory: string, input: string, output: string, options: UpscaleOptions, execution: UpscaleExecution = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    checkUpscaleCanceled(execution.signal);
    let timedOut = false, failed = false, remainder = "", lastPercent = -1;
    // A relative trusted model directory avoids the upstream Windows path buffer.
    const child = spawn(join(directory, "realesrgan-ncnn-vulkan.exe"), ["-i", input, "-o", output, "-m", "models", "-n", options.model, "-s", "4", "-t", String(options.tileSize), "-j", "1:1:1", "-f", "png"], {
      cwd: directory, windowsHide: true, shell: false, stdio: ["ignore", "ignore", "pipe"],
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: join(process.env.SystemRoot || "C:\\Windows", "System32") },
    });
    const abort = () => { child.kill(); };
    execution.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, execution.timeoutMs ?? 10 * 60_000);
    child.stderr?.on("data", (chunk: Buffer) => {
      const lines = (remainder + chunk.toString("utf8")).split(/[\r\n]/);
      remainder = lines.pop()!.slice(-8192);
      for (const line of lines) {
        const match = /^\s*(\d+(?:\.\d+)?)%\s*$/.exec(line);
        if (!match) continue;
        const percent = Number(match[1]);
        if (percent >= 0 && percent <= 100 && percent > lastPercent && !execution.signal?.aborted) {
          lastPercent = percent;
          execution.onProgress?.({ stage: "inference", percent });
        }
      }
    });
    // Node emits close after error; wait for it before deleting native input/output.
    child.once("error", () => { failed = true; });
    child.once("close", (code) => {
      clearTimeout(timer);
      execution.signal?.removeEventListener("abort", abort);
      if (execution.signal?.aborted) reject(new ImageToolError("CANCELED"));
      else if (timedOut) reject(new ImageToolError("UPSCALE_TIMEOUT"));
      else if (failed || code !== 0) reject(new ImageToolError("UPSCALE_ENGINE_FAILED"));
      else resolve();
    });
    if (execution.signal?.aborted) abort();
  });
}
