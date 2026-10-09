// Explicit opt-in live verification, bundled only into ignored test output.
// Never included in product entrypoints. No license or platform access override.
import { app } from "electron";
import { mkdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { normalizeShare, contentIdFromUrl, videoError } from "../src/shared/video-parser";
import { readPublicDouyinPage } from "../src/main/video-parser/browser-reader";
import { normalizeBrowserData } from "../src/main/video-parser/browser-data";
import { secureRequest } from "../src/main/video-parser/network";
import { downloadFile, publishMedia } from "../src/main/video-parser/transfer";

app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  try {
    const source = normalizeShare(process.env.CLARUNE_DOUYIN_TEST_VIDEO_URL ?? "");
    const id = contentIdFromUrl(new URL(source)); if (!id) throw new Error("A full authorized work link is required");
    const result = normalizeBrowserData(await readPublicDouyinPage(id, AbortSignal.timeout(180_000)), id, source);
    if (result.mediaType !== "video") throw new Error("Expected a video");
    console.log(JSON.stringify({ stage: "parsed", id, durationMs: result.durationMs, width: result.width, height: result.height }));
    const asset = result.assets.find(item => item.kind === "video")!;
    const directory = join(app.getPath("downloads"), "EVEING Clarune", "Douyin"); await mkdir(directory, { recursive: true });
    const part = join(directory, `.clarune-live-${Date.now()}-${id}.part`);
    let last = 0;
    const format = await downloadFile({ url: asset.url, kind: "video", part, client: secureRequest, signal: AbortSignal.timeout(600_000), state: { bytes: 0, total: null },
      progress: state => { if (Date.now() - last > 5000) { last = Date.now(); console.log(JSON.stringify({ stage: "downloading", bytes: state.bytes, total: state.total })); } },
    });
    const file = await publishMedia(part, directory, `Clarune-test-${id}`, format.extension);
    const hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk);
    console.log(JSON.stringify({ stage: "completed", file, bytes: (await stat(file)).size, sha256: hash.digest("hex"), format: format.extension }));
    app.exit(0);
  } catch (error) { console.log(JSON.stringify({ stage: "failed", error: videoError(error) })); app.exit(1); }
});
