import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createLargeUpscaleFile, largeInputAllowed, publishLargeUpscale } from "../src/main/upscale/large-file";

const options = { scale: 3 as const, model: "realesrgan-x4plus" as const, tileSize: 128 as const };

describe("file-backed large AI output", () => {
  it("accepts the reported 2556 × 5538 source only for the tiled general model", () => {
    expect(largeInputAllowed(2556, 5538, options.model)).toBe(true);
    expect(largeInputAllowed(2556, 5538, "real-hat-x4")).toBe(false);
    expect(largeInputAllowed(4000, 4001, options.model)).toBe(false);
  });

  it("keeps the full result on disk and sends only a bounded preview", async () => {
    const source = await sharp({ create: { width: 2560, height: 1000, channels: 3, background: "#4581be" } }).png().toBuffer();
    const destination = await mkdtemp(join(tmpdir(), "clarune-large-save-test-"));
    let result: Awaited<ReturnType<typeof createLargeUpscaleFile>> | undefined;
    try {
      result = await createLargeUpscaleFile(source, options, destination, {}, async (_runtime, _input, output) => {
        await sharp({ create: { width: 10240, height: 4000, channels: 3, background: "#4581be" } }).png().toFile(output);
      });
      expect([result.width, result.height]).toEqual([7680, 3000]);
      expect((await sharp(result.path).metadata()).width).toBe(7680);
      expect(result.size).toBe((await stat(result.path)).size);
      const preview = await sharp(result.preview).metadata();
      expect(Math.max(preview.width!, preview.height!)).toBeLessThanOrEqual(4096);
      expect(result.preview.length).toBeLessThan(result.size);
      const saved = join(destination, "full.png");
      expect(await publishLargeUpscale(result.path, saved, "png", 100)).toBe((await stat(saved)).size);
      expect((await sharp(await readFile(saved)).metadata()).height).toBe(3000);
      await expect(publishLargeUpscale(result.path, saved, "png", 100)).rejects.toThrow("FILE_EXISTS");
      for (const format of ["jpeg", "webp"] as const) {
        const converted = join(destination, `full.${format}`);
        expect(await publishLargeUpscale(result.path, converted, format, 85)).toBe((await stat(converted)).size);
        const metadata = await sharp(converted).metadata();
        expect([metadata.format, metadata.width, metadata.height]).toEqual([format, 7680, 3000]);
      }
    } finally {
      if (result) await rm(result.directory, { recursive: true, force: true });
      await rm(destination, { recursive: true, force: true });
    }
  }, 120_000);
});
