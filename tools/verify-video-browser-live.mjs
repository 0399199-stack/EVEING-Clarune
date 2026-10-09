import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const require = createRequire(import.meta.url);
if (!process.env.CLARUNE_DOUYIN_TEST_VIDEO_URL) throw new Error("Set an authorized CLARUNE_DOUYIN_TEST_VIDEO_URL.");
const { build } = createRequire(require.resolve("vite"))("esbuild");
const project = resolve(import.meta.dirname, ".."); const review = join(project, "UI-review-video-browser");
await mkdir(review, { recursive: true });
const entry = join(review, "live-entry.cjs");
await build({ entryPoints: [join(import.meta.dirname, "verify-video-browser-entry.ts")], outfile: entry, bundle: true, platform: "node", format: "cjs", external: ["electron"] });
const profile = await mkdtemp(join(tmpdir(), "clarune-browser-download-"));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [entry, `--user-data-dir=${profile}`], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
const records = []; let pending = "";
child.stdout.on("data", chunk => {
  pending += chunk.toString(); const lines = pending.split(/\r?\n/); pending = lines.pop();
  for (const line of lines) { try { const record = JSON.parse(line); if (record.stage) { records.push(record); console.log(JSON.stringify(record)); } } catch {} }
});
// Chromium diagnostics can contain signed URLs; never echo/store them.
child.stderr.resume();
const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
await writeFile(join(review, "download-result.json"), JSON.stringify({ code, records }, null, 2));
process.exitCode = code ?? 1;
