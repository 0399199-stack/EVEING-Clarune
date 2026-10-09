import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { _electron } = require(process.env.CLARUNE_PLAYWRIGHT_MODULE || "playwright");
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const review = resolve(process.env.CLARUNE_REVIEW_DIR || join(project, "UI-review-video-parser"));
const scratch = await mkdtemp(join(tmpdir(), "clarune-video-ui-")); await mkdir(review, { recursive: true });
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: process.env.CLARUNE_PREVIEW_EXE || require("electron"),
  args: process.env.CLARUNE_PREVIEW_EXE ? [`--user-data-dir=${join(scratch, "profile")}`] : [project, `--user-data-dir=${join(scratch, "profile")}`], env });
const checks = []; const errors = [];
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByTestId("nav-enhance").waitFor();
  assert.equal(await page.getByRole("button", { name: "视频解析", exact: true }).getAttribute("aria-expanded"), "true");
  assert.equal(await page.getByTestId("nav-douyin").isVisible(), true); checks.push("fresh launch expands video group outside its child route");
  await page.evaluate(() => { localStorage.setItem("clarune.language", "zh-CN"); location.hash = "/video-parser/douyin"; });
  await page.reload();
  await page.getByRole("heading", { name: "抖音去水印", exact: true }).waitFor();
  assert.equal(await page.getByTestId("nav-douyin").getAttribute("aria-current"), "page");
  assert.equal(await page.getByRole("button", { name: "视频解析", exact: true }).getAttribute("aria-expanded"), "true"); checks.push("direct child route opens and highlights nested navigation");
  const parent = page.getByRole("button", { name: "视频解析", exact: true });
  await parent.focus(); await page.keyboard.press("Enter"); assert.equal(await page.getByTestId("nav-douyin").isVisible(), false);
  await page.keyboard.press("Space"); assert.equal(await page.getByTestId("nav-douyin").isVisible(), true); checks.push("parent toggles with Enter and Space");
  assert.equal(await page.getByRole("button", { name: "开始解析", exact: true }).isEnabled(), false);
  await page.getByLabel("抖音链接或分享文案", { exact: true }).fill("https://www.douyin.com.evil.example/video/12345678");
  await page.getByRole("button", { name: "开始解析", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "允许范围" }).waitFor();
  assert.equal(await page.getByText("暂无下载任务。解析成功后，点击相应下载按钮。", { exact: true }).isVisible(), true); checks.push("invalid input rejected before IPC with no download task");
  await page.getByRole("button", { name: "清空", exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 850));
  await page.screenshot({ path: join(review, "01-real-empty-page.png"), fullPage: true });
  if (process.env.CLARUNE_PREVIEW_EXE) {
    const reply = await page.evaluate(() => window.clarune.videoParser.snapshot());
    assert.equal(reply.ok, true); assert.equal(reply.value.engineAvailable, true);
    await page.getByText("当前已实测公开视频解析、预览与下载；图集尚未完成真实联调，打包版暂不开放。", { exact: true }).waitFor();
    checks.push("packaged video capability enabled with honest gallery limitation");
  }

  // Explicit OFFLINE UI fixture: only this isolated test process replaces IPC handlers.
  // It never claims to be a platform result and does not save/download real media.
  await app.evaluate(({ ipcMain }) => {
    globalThis.__claruneVideoTest = { calls: 0, downloads: 0 };
    ipcMain.removeHandler("video-parser:parse");
    ipcMain.handle("video-parser:parse", async (_event, id, text) => {
      globalThis.__claruneVideoTest.calls++;
      await new Promise(resolve => setTimeout(resolve, text.includes("slow") ? 500 : 20));
      const result = { sessionId: id, platform: "douyin", contentId: "1234567890123456789", sourceUrl: "https://www.douyin.com/video/1234567890123456789", canonicalUrl: "https://www.douyin.com/video/1234567890123456789", mediaType: "video", title: "离线交互测试数据 · 非真实抖音解析", authorName: "Synthetic fixture", cover: null, durationMs: null, width: null, height: null, assets: [{ resourceId: "video-1", kind: "video", order: 1, format: null, width: null, height: null, size: null }], variants: [], capabilities: { preview: true, download: true, copyDirectLink: false }, engineId: "offline-ui-fixture", engineVersion: "test", parsedAt: new Date().toISOString() };
      return { ok: true, value: [{ sourceUrl: result.sourceUrl, state: "succeeded", result }] };
    });
    ipcMain.removeHandler("video-parser:enqueue");
    ipcMain.handle("video-parser:enqueue", () => { globalThis.__claruneVideoTest.downloads++; return { ok: false, error: "LICENSE_REQUIRED" }; });
  });
  const input = page.getByLabel("抖音链接或分享文案", { exact: true });
  await input.fill("https://v.douyin.com/slow/"); await page.getByRole("button", { name: "开始解析", exact: true }).click();
  await page.getByRole("button", { name: "清空", exact: true }).click();
  await page.waitForTimeout(650); assert.equal(await page.getByRole("heading", { name: "离线交互测试数据 · 非真实抖音解析" }).count(), 0); checks.push("clear invalidates a late parser response");
  await input.fill("https://v.douyin.com/fixture/"); await page.getByRole("button", { name: "开始解析", exact: true }).click();
  await page.getByRole("heading", { name: "离线交互测试数据 · 非真实抖音解析" }).waitFor();
  assert.equal(await app.evaluate(() => globalThis.__claruneVideoTest.downloads), 0); checks.push("parsing does not enqueue a download");
  assert.equal(await page.getByRole("button", { name: "下载封面", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "下载音频", exact: true }).count(), 0); checks.push("missing resource actions and unknown metadata are hidden");
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await page.getByText("当前格式暂不支持预览，或预览资源不可用；仍可尝试下载。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "下载视频", exact: true }).isEnabled(), true); checks.push("preview failure preserves parsed metadata and download action");
  await page.screenshot({ path: join(review, "02-offline-result-fixture.png"), fullPage: true });
  await page.getByRole("button", { name: "下载视频", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  assert.equal(await app.evaluate(() => globalThis.__claruneVideoTest.downloads), 1);
  await page.getByRole("button", { name: "关闭", exact: true }).click(); checks.push("explicit download is separate and honors existing activation UI");
  await page.getByRole("tab", { name: "解析历史", exact: true }).click();
  await page.getByRole("tab", { name: "解析历史", exact: true }).focus(); await page.keyboard.press("ArrowLeft");
  assert.equal(await page.getByRole("tab", { name: "下载任务", exact: true }).getAttribute("aria-selected"), "true");
  await page.keyboard.press("End"); checks.push("record tabs support arrow and End keys");
  await page.getByRole("button", { name: "清空解析历史", exact: true }).click(); checks.push("history controls reachable within page");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 720));
  await page.screenshot({ path: join(review, "03-small-window-fixture.png"), fullPage: true });
  const overflow = await page.locator(".video-parser-page").evaluate(element => element.scrollWidth > element.clientWidth + 2);
  assert.equal(overflow, false); checks.push("small window has no horizontal overflow");
  await page.getByTestId("nav-settings").click();
  await page.getByRole("button", { name: "English", exact: true }).click();
  await page.getByTestId("nav-douyin").click(); await page.getByRole("heading", { name: "Douyin watermark-free", exact: true }).waitFor(); checks.push("English UI and other navigation remain working");
  assert.deepEqual(errors, []);
  await writeFile(join(review, "results.json"), JSON.stringify({ checks, pageErrors: errors, fixtureOnly: true, liveParseDownloadVerified: false, packaged: Boolean(process.env.CLARUNE_PREVIEW_EXE), scratch }, null, 2));
  console.log(JSON.stringify({ checks: checks.length, pageErrors: errors, review, liveParseDownloadVerified: false }));
} finally { await app.close(); }
