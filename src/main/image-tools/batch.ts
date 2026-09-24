import { isAbsolute, join } from "node:path";
import type { BatchItemResult, BatchJob, BatchProgress, BatchSummary } from "../../shared/image-tools";
import { bounded, errorResult, ImageToolError, LIMITS, processImage, writeNewFile } from "./processor";

export function suggestedFilename(name: unknown, extension: string): string {
  let safe = typeof name === "string" ? name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\.[^.]*$/, "").replace(/[. ]+$/g, "").slice(0, 100) : "";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = `Clarune-${safe}`;
  return `${safe || "Clarune-export"}.${extension}`;
}

export function validateBatch(job: BatchJob): void {
  if (!job || typeof job !== "object" || typeof job.id !== "string" || !/^[\w-]{1,128}$/.test(job.id) || !Array.isArray(job.images) || !job.images.length || job.images.length > LIMITS.pdfImages) throw new ImageToolError("INVALID_OPTIONS");
  let total = 0;
  const ids = new Set<string>();
  for (const item of job.images) {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id || item.id.length > 128 || ids.has(item.id) || typeof item.name !== "string" || item.name.length > 1000 || !item.options || typeof item.options !== "object") throw new ImageToolError("INVALID_OPTIONS");
    ids.add(item.id);
    if (!(item.bytes instanceof Uint8Array) || !item.bytes.length) throw new ImageToolError("INVALID_IMAGE");
    if (item.bytes.length > LIMITS.bytes) throw new ImageToolError("INPUT_TOO_LARGE");
    total += item.bytes.length;
    const watermark = item.options.watermark?.image;
    if (watermark !== undefined) {
      if (!(watermark instanceof Uint8Array) || !watermark.length) throw new ImageToolError("INVALID_IMAGE");
      if (watermark.length > LIMITS.bytes) throw new ImageToolError("INPUT_TOO_LARGE");
      total += watermark.length;
    }
    if (total > LIMITS.pdfBytes) throw new ImageToolError("INPUT_TOO_LARGE");
  }
}

async function writeUnique(directory: string, name: string, extension: string, bytes: Uint8Array): Promise<string> {
  const filename = suggestedFilename(name, extension);
  const stem = filename.slice(0, -(extension.length + 1));
  // Exclusive creation avoids races with other apps and preserves every existing file.
  for (let suffix = 0; suffix < 10_000; suffix++) {
    const path = join(directory, suffix ? `${stem} (${suffix}).${extension}` : filename);
    try { await writeNewFile(path, bytes); return path; }
    catch (error) { if (!(error instanceof ImageToolError) || error.message !== "FILE_EXISTS") throw error; }
  }
  throw new ImageToolError("WRITE_FAILED");
}

/** Directory comes only from the main-process native picker, never from renderer job data. */
export async function runBatch(job: BatchJob, directory: string, canceled: () => boolean, progress: (value: BatchProgress) => void, requireLicense?: () => Promise<void>): Promise<BatchSummary> {
  validateBatch(job);
  if (!isAbsolute(directory)) throw new ImageToolError("INVALID_OPTIONS");
  const items: BatchItemResult[] = [];
  let wasCanceled = false;
  for (const item of job.images) {
    let result: BatchItemResult;
    if (canceled()) {
      wasCanceled = true;
      result = { id: item.id, name: item.name, status: "canceled" };
    } else {
      try {
        await requireLicense?.();
        if (canceled()) throw new ImageToolError("CANCELED");
        progress({ id: job.id, total: job.images.length, completed: items.length, currentName: item.name });
        const image = await bounded(() => processImage({ bytes: item.bytes, options: item.options }));
        await requireLicense?.();
        const path = await writeUnique(directory, item.name, image.format === "jpeg" ? "jpg" : image.format, image.bytes);
        result = { id: item.id, name: item.name, status: "saved", file: { path, size: image.size, width: image.width, height: image.height } };
      } catch (error) {
        const failure = errorResult(error);
        if (!failure.ok && failure.error === "CANCELED") {
          wasCanceled = true;
          result = { id: item.id, name: item.name, status: "canceled" };
        } else result = { id: item.id, name: item.name, status: "failed", error: failure.ok ? "PROCESSING_FAILED" : failure.error };
      }
    }
    items.push(result);
    progress({ id: job.id, total: job.images.length, completed: items.length, item: result });
  }
  return { directory, items, canceled: wasCanceled || canceled() };
}
