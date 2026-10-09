import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const require = createRequire(import.meta.url);
const { _electron } = require(process.env.CLARUNE_PLAYWRIGHT_MODULE || "playwright");
const source = process.env.CLARUNE_DOUYIN_TEST_VIDEO_URL;
if (!source) throw new Error("Set an authorized CLARUNE_DOUYIN_TEST_VIDEO_URL first.");
const project = resolve(import.meta.dirname, "..");
const scratch = await mkdtemp(join(tmpdir(), "clarune-browser-live-ui-"));
const review = join(project, "UI-review-video-browser"); await mkdir(review, { recursive: true });
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: process.env.CLARUNE_PREVIEW_EXE || require("electron"),
  args: process.env.CLARUNE_PREVIEW_EXE ? [`--user-data-dir=${join(scratch, "profile")}`] : [project, `--user-data-dir=${join(scratch, "profile")}`], env });
try {
  const page = await app.firstWindow();
  page.on("response", response => { if (response.url().startsWith("clarune-media:")) console.log(JSON.stringify({ previewStatus: response.status(), type: response.headers()["content-type"], error: response.headers()["x-clarune-error"] })); });
  await app.evaluate(({ app }) => {
    globalThis.__browserEvidence = { mediaRequests: 0, failures: [], windows: 0 };
    app.on("browser-window-created", (_event, win) => {
      globalThis.__browserEvidence.windows++;
      win.webContents.on("did-fail-load", (_e, code, _description, _url, main) => { if (main) globalThis.__browserEvidence.failures.push(code); });
      win.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
        if (details.resourceType === "media" || new URL(details.url).hostname.endsWith("douyinvod.com")) globalThis.__browserEvidence.mediaRequests++;
        callback({});
      });
    });
  });
  await page.getByTestId("nav-douyin").click();
  await page.getByLabel("抖音链接或分享文案", { exact: true }).fill(source);
  await page.getByRole("button", { name: "开始解析", exact: true }).click();
  await page.getByText("解析成功，尚未下载。", { exact: true }).waitFor({ timeout: 185000 });
  const snapshot = await page.evaluate(() => window.clarune.videoParser.snapshot());
  assert.equal(snapshot.ok, true); assert.equal(snapshot.value.tasks.length, 0);
  const evidence = await app.evaluate(() => globalThis.__browserEvidence);
  assert.equal(evidence.mediaRequests, 0); assert.equal(evidence.windows, 1);
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await page.waitForFunction(() => { const v = document.querySelector("video"); return v && v.readyState >= 1 && v.videoWidth > 0; }, null, { timeout: 45000 });
  await page.locator("video").evaluate(v => v.play());
  await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2, null, { timeout: 15000 });
  const preview = await page.locator("video").evaluate(v => ({ width: v.videoWidth, height: v.videoHeight, duration: v.duration, muted: v.muted }));
  assert.equal(preview.muted, true);
  await page.screenshot({ path: join(review, "live-preview.png"), fullPage: true });
  await page.getByRole("button", { name: "关闭预览", exact: true }).click();
  await page.getByRole("button", { name: "下载视频", exact: true }).click();
  await page.getByRole("dialog").waitFor(); await page.getByRole("button", { name: "关闭", exact: true }).click();
  assert.equal((await page.evaluate(() => window.clarune.videoParser.snapshot())).value.tasks.length, 0);
  await page.getByRole("button", { name: "清空", exact: true }).click();
  await page.getByLabel("抖音链接或分享文案", { exact: true }).fill(source);
  await page.getByRole("button", { name: "开始解析", exact: true }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "取消解析", exact: true }).click();
  await page.waitForTimeout(500);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  const result = { realParse: true, realPreview: true, noAutomaticDownload: true, activationEnforced: true, cancellationClosesBrowser: true, evidence, preview, packaged: Boolean(process.env.CLARUNE_PREVIEW_EXE) };
  await writeFile(join(review, "results.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  const page = (await app.windows())[0];
  if (page) console.log(JSON.stringify({ media: await page.locator("video").evaluateAll(nodes => nodes.map(v => ({ ready: v.readyState, network: v.networkState, error: v.error?.code }))), alerts: await page.getByRole("alert").allTextContents() }));
  console.log(JSON.stringify({ evidence: await app.evaluate(() => globalThis.__browserEvidence), windows: await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ title: w.getTitle(), host: (() => { try { return new URL(w.webContents.getURL()).hostname; } catch { return ""; } })() }))) }));
  throw error;
} finally { await app.close(); }
