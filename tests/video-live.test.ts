import { afterAll, expect, it } from "vitest";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDouyinProvider } from "../src/main/video-parser/douyin-provider";
import { secureRequest } from "../src/main/video-parser/network";
import { downloadFile } from "../src/main/video-parser/transfer";

// Explicit opt-in only: the operator must own/have permission to save these works.
// Files stay in the OS temp directory for manual codec/content inspection.
const provider = createDouyinProvider(secureRequest);
const abort = new AbortController();
afterAll(() => abort.abort());
for (const [name, value, expected] of [
  ["video", process.env.CLARUNE_DOUYIN_TEST_VIDEO_URL, "video"],
  ["gallery", process.env.CLARUNE_DOUYIN_TEST_GALLERY_URL, "gallery"],
] as const) {
  it.skipIf(!value)(`live authorized ${name}: parse and separately download resources`, async () => {
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]);
    const result = await provider.parse(value!, signal);
    expect(result.mediaType).toBe(expected); expect(result.contentId).toMatch(/^\d{8,30}$/);
    const directory = await mkdtemp(join(tmpdir(), "clarune-douyin-live-"));
    for (const asset of result.assets.filter(asset => expected === "gallery" ? asset.kind === "image" : asset.kind === "video")) {
      const part = join(directory, asset.resourceId + ".part");
      const format = await downloadFile({ url: asset.url, kind: asset.kind, part, client: secureRequest, signal, state: { bytes: 0, total: null }, progress: () => {} });
      expect(format.extension).toBeTruthy(); expect((await stat(part)).size).toBeGreaterThan(0);
    }
  }, 125_000);
}
