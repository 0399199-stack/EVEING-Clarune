import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { runBatch, suggestedFilename, validateBatch } from "../src/main/image-tools/batch";
import { writeNewFile } from "../src/main/image-tools/processor";
import type { BatchJob, BatchProgress } from "../src/shared/image-tools";

async function fixture(): Promise<BatchJob> {
  const bytes = await sharp({ create: { width: 80, height: 60, channels: 4, background: "red" } }).png().toBuffer();
  return { id: "test-batch", images: Array.from({ length: 3 }, (_, i) => ({ id: String(i), name: "original.png", bytes, options: { format: "png", quality: 100, resize: { width: 40, height: 30, fit: "fill" } } })) };
}

describe("batch local exports", () => {
  it("processes every image, exports unique names and never replaces an existing original", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clarune-batch-test-"));
    try {
      const job = await fixture(), original = job.images[0].bytes;
      await writeNewFile(join(dir, "original.png"), original);
      const progress: BatchProgress[] = [];
      const result = await runBatch(job, dir, () => false, (event) => progress.push(event));
      expect(result.canceled).toBe(false);
      expect(result.items.map((item) => item.status)).toEqual(["saved", "saved", "saved"]);
      expect(await readFile(join(dir, "original.png"))).toEqual(Buffer.from(original));
      expect(await readdir(dir)).toEqual(["original (1).png", "original (2).png", "original (3).png", "original.png"]);
      for (const item of result.items) {
        const metadata = await sharp(await readFile(item.file!.path)).metadata();
        expect([metadata.width, metadata.height]).toEqual([40, 30]);
      }
      expect(progress.filter((event) => event.item).map((event) => event.completed)).toEqual([1, 2, 3]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("continues after a bad image and reports each item's real outcome", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clarune-batch-test-"));
    try {
      const job = await fixture(); job.images[1].bytes = Buffer.from("invalid image");
      const result = await runBatch(job, dir, () => false, () => undefined);
      expect(result.items.map((item) => item.status)).toEqual(["saved", "failed", "saved"]);
      expect(result.items[1].error).toBe("INVALID_IMAGE");
      expect((await readdir(dir)).length).toBe(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("cancels between images, keeps completed output, and marks the unprocessed remainder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clarune-batch-test-"));
    try {
      let canceled = false;
      const result = await runBatch(await fixture(), dir, () => canceled, (event) => { if (event.item?.status === "saved") canceled = true; });
      expect(result.canceled).toBe(true);
      expect(result.items.map((item) => item.status)).toEqual(["saved", "canceled", "canceled"]);
      expect((await readdir(dir)).length).toBe(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("rejects excessive/ambiguous jobs and sanitizes traversal and reserved Windows filenames", async () => {
    const job = await fixture();
    expect(() => validateBatch({ ...job, images: [] })).toThrow("INVALID_OPTIONS");
    expect(() => validateBatch({ ...job, images: [...job.images, ...job.images] })).toThrow("INVALID_OPTIONS");
    expect(() => validateBatch({ ...job, images: Array.from({ length: 61 }, (_, i) => ({ ...job.images[0], id: String(i) })) })).toThrow("INVALID_OPTIONS");
    expect(() => validateBatch({ ...job, images: [{ ...job.images[0], bytes: new Uint8Array(65 * 1024 * 1024) }] })).toThrow("INPUT_TOO_LARGE");
    expect(() => validateBatch({ ...job, images: Array.from({ length: 3 }, (_, i) => ({ ...job.images[0], id: String(i), bytes: new Uint8Array(45 * 1024 * 1024) })) })).toThrow("INPUT_TOO_LARGE");
    expect(suggestedFilename("../../outside.png", "webp")).not.toMatch(/[\\/]/);
    expect(suggestedFilename("CON.png", "png")).toBe("Clarune-CON.png");
    await expect(runBatch(job, "relative-directory", () => false, () => undefined)).rejects.toThrow("INVALID_OPTIONS");
  });
});
