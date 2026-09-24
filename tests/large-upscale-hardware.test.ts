import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { configureUpscaleRuntime, upscaleLargeImage } from "../src/main/upscale/runtime";
import { publishLargeUpscale } from "../src/main/upscale/large-file";

describe.skipIf(!process.env.CLARUNE_LARGE_AI_RUNTIME)("real large AI image", () => {
  it("processes and saves a file-backed portrait at its full 3× dimensions", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "clarune-large-hardware-test-"));
    const small = process.env.CLARUNE_LARGE_AI_SMALL === "1";
    const width = small ? 2560 : 2556;
    const height = small ? 1000 : 5538;
    let result: Awaited<ReturnType<typeof upscaleLargeImage>> | undefined;
    try {
      configureUpscaleRuntime(join(scratch, "runtime.json"), [process.env.CLARUNE_LARGE_AI_RUNTIME!]);
      const source = await sharp({ create: { width, height, channels: 3, background: "#6985a6" } })
        .composite([{ input: Buffer.from(`<svg width="${width}" height="${height}"><circle cx="${Math.floor(width / 2)}" cy="${Math.floor(height / 2)}" r="220" fill="#e8b971"/></svg>`) }])
        .png().toBuffer();
      const stages: string[] = [];
      result = await upscaleLargeImage(source, { scale: 3, model: "realesrgan-x4plus", tileSize: 128 }, { onProgress: (progress) => stages.push(progress.stage) });
      expect([result.width, result.height]).toEqual([width * 3, height * 3]);
      expect((await sharp(result.path, { limitInputPixels: 256_000_000 }).metadata()).format).toBe("png");
      expect((await sharp(result.preview).metadata()).height).toBeLessThanOrEqual(4096);
      const output = join(scratch, "saved-full.png");
      expect(await publishLargeUpscale(result.path, output, "png", 100)).toBe((await stat(output)).size);
      expect(stages).toContain("inference");
      expect(stages).toContain("finishing");
    } finally {
      if (result) await rm(result.directory, { recursive: true, force: true });
      await rm(scratch, { recursive: true, force: true });
    }
  }, 45 * 60_000);
});
