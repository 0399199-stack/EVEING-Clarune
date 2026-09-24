import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { _electron } = require(process.env.CLARUNE_PLAYWRIGHT_MODULE || "playwright");
const sharp = require(process.env.CLARUNE_SHARP_MODULE || "sharp");
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const review = process.env.CLARUNE_REVIEW_DIR || join(project, "UI-review");
const scratch = await mkdtemp(join(tmpdir(), "clarune-viewer-"));
await mkdir(review, { recursive: true });
// Deliberately synthetic fixtures, not AI enhancement output or user images.
const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000">
  <defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#324e8c"/><stop offset="1" stop-color="#c7e1e1"/></linearGradient>
  <pattern id="lines" width="12" height="12" patternUnits="userSpaceOnUse"><path d="M0 0h12M0 0v12" stroke="#f2f5e1" stroke-width="1.3"/></pattern></defs>
  <rect width="1600" height="1000" fill="url(#sky)"/><circle cx="1190" cy="220" r="85" fill="#f8dbaa"/>
  <path d="M0 680 370 235 630 600 950 300 1600 730V1000H0Z" fill="#527487"/>
  <path d="M210 460 370 235 535 470 386 400 328 470Z" fill="#e6e9ed"/>
  <path d="M0 820 460 560 1020 820 1430 480 1600 670V1000H0Z" fill="#2d5664"/>
  <rect x="160" y="640" width="360" height="220" fill="url(#lines)"/>
  <text x="80" y="120" font-family="sans-serif" font-size="44" fill="white">CLARUNE · UI TEST</text>
  <text x="80" y="925" font-family="sans-serif" font-size="25" fill="white">Synthetic comparison fixture · not an AI enhancement demo</text>
</svg>`);
const original = join(scratch, "UI-test-original.png");
const result = join(scratch, "UI-test-result.png");
const mismatch = join(scratch, "wrong-ratio.png");
const corrupt = join(scratch, "corrupt.png");
const transparent = join(scratch, "transparent.png");
await sharp(svg).resize(800, 500).blur(1.2).png().toFile(original);
await sharp(svg).png().toFile(result);
await sharp({ create: { width: 100, height: 100, channels: 3, background: "#abc" } }).png().toFile(mismatch);
await writeFile(corrupt, "not an image");
await sharp({ create: { width: 800, height: 500, channels: 4,
  background: { r: 220, g: 75, b: 40, alpha: .5 } } }).png().toFile(transparent);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: process.env.CLARUNE_PREVIEW_EXE || require("electron"),
  args: process.env.CLARUNE_PREVIEW_EXE ? [`--user-data-dir=${join(scratch, "profile")}`]
    : [project, `--user-data-dir=${join(scratch, "profile")}`], env });
const page = await app.firstWindow();
await page.emulateMedia({ reducedMotion: "reduce" });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
page.setDefaultTimeout(10000);
const checks = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const viewport = page.getByTestId("image-viewport");
const zoom = async () => Number(await viewport.getAttribute("data-zoom"));
const resize = async (width, height) => {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
  // Windows rounds non-client bounds at fractional display scaling.
  await page.waitForFunction(size => Math.abs(innerWidth - size[0]) <= 4 && Math.abs(innerHeight - size[1]) <= 4, [width, height]);
  return page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
};
try {
  await page.locator(".sidebar-brand-card").waitFor();
  await page.evaluate(() => { localStorage.setItem("clarune.language", "zh-CN"); localStorage.setItem("clarune.theme", "light"); });
  await page.reload();
  await resize(1280, 820);
  await page.getByRole("heading", { name: "图像工作台" }).waitFor();
  check("EVEING Clarune title", (await page.title()) === "EVEING Clarune");
  check("Comparison disabled without image", await page.getByRole("button", { name: "滑动对比", exact: true }).isDisabled());
  await page.screenshot({ path: join(review, "00-workspace-empty.png") });
  await page.getByTestId("original-file-input").setInputFiles(original);
  await page.locator(".viewer-image").waitFor();
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="image-viewport"]').dataset.zoom) !== 1);
  const fitted = await zoom();
  const box = await viewport.boundingBox();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
  await page.mouse.wheel(0, -400);
  await page.waitForFunction(before => Number(document.querySelector('[data-testid="image-viewport"]').dataset.zoom) > before, fitted);
  const enlarged = await zoom();
  check("Wheel zooms in", enlarged > fitted);
  await page.mouse.wheel(0, 200);
  await page.waitForFunction(before => Number(document.querySelector('[data-testid="image-viewport"]').dataset.zoom) < before, enlarged);
  check("Wheel zooms out", (await zoom()) < enlarged);
  await page.getByRole("button", { name: "1:1", exact: true }).click();
  await page.mouse.move(box.x + box.width * .3, box.y + box.height * .3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .3 + 25, box.y + box.height * .3 + 20);
  const beforeDragZoom = await zoom();
  await page.mouse.wheel(0, -160);
  await page.waitForFunction(before => Number(document.querySelector('[data-testid="image-viewport"]').dataset.zoom) > before, beforeDragZoom);
  const duringDragZoom = await zoom();
  await page.mouse.move(box.x + box.width * .3 + 45, box.y + box.height * .3 + 40);
  await page.mouse.up();
  check("Zoom while dragging does not revert scale", Math.abs(await zoom() - duringDragZoom) < .0001);
  await page.getByTestId("result-file-input").setInputFiles(result);
  await page.locator(".comparison-handle").waitFor();
  check("Two aligned layers", (await page.locator(".viewer-image").count()) === 2);
  const transforms = await page.locator(".viewer-image").evaluateAll(imgs => imgs.map(img => img.style.transform));
  check("Shared original/result transform", transforms[0] === transforms[1]);
  const handle = page.locator(".comparison-handle");
  const handleBox = await handle.boundingBox();
  const compareBox = await viewport.boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(compareBox.x + compareBox.width * .73, compareBox.y + compareBox.height / 2, { steps: 10 });
  await page.mouse.up();
  check("Pointer comparison slider", Math.abs(Number(await handle.getAttribute("aria-valuenow")) - 73) <= 1);
  await handle.focus();
  await page.keyboard.press("Home");
  check("Comparison endpoint original hidden", await handle.getAttribute("aria-valuenow") === "0");
  await page.keyboard.press("End");
  check("Comparison endpoint result hidden", await handle.getAttribute("aria-valuenow") === "100");
  const range = page.locator('.viewer-comparison-control input[type="range"]');
  await range.fill("50");
  check("Lower range updates divider", await handle.getAttribute("aria-valuenow") === "50");
  await page.locator("#enhancement-scale").fill("3");
  check("2x–4x enhancement range", await page.getByTestId("enhancement-scale-number").inputValue() === "3");
  await page.getByTestId("enhancement-scale-number").fill("4");
  await page.getByTestId("enhancement-scale-number").press("Tab");
  check("Typed enhancement scale updates slider", await page.locator("#enhancement-scale").inputValue() === "4");
  await page.getByTestId("viewer-split-number").fill("37");
  await page.getByTestId("viewer-split-number").press("Tab");
  check("Typed comparison percent updates divider", await handle.getAttribute("aria-valuenow") === "37");
  await page.getByTestId("viewer-zoom-number").fill("150");
  await page.getByTestId("viewer-zoom-number").press("Tab");
  check("Typed viewer zoom percent", await page.getByTestId("viewer-zoom-number").inputValue() === "150");
  await page.getByRole("button", { name: "适应窗口", exact: true }).click();
  await page.screenshot({ path: join(review, "01-workspace-light.png") });
  await page.getByTestId("result-file-input").setInputFiles(mismatch);
  await page.getByRole("alert").waitFor();
  check("Mismatched ratio rejected, prior result preserved", await page.locator(".viewer-image").count() === 2);
  await page.getByTestId("original-file-input").setInputFiles(corrupt);
  await page.getByRole("alert").filter({ hasText: "无法" }).waitFor();
  check("Decode failure preserves original", (await page.locator(".viewer-file-info strong").innerText()) === "UI-test-original.png");
  await page.getByTestId("original-file-input").setInputFiles(original);
  await page.waitForFunction(() => !document.querySelector(".comparison-handle"));
  check("New original clears previous comparison", await page.getByRole("button", { name: "滑动对比", exact: true }).isDisabled());
  await page.getByTestId("result-file-input").setInputFiles(result);
  await handle.waitFor();
  for (const [width, height] of [[980, 680], [1600, 1000]]) {
    const actual = await resize(width, height);
    const bounds = await page.locator(".image-viewer").boundingBox();
    const canvas = await viewport.boundingBox();
    check(`Viewer fits ${actual.width}x${actual.height}`, bounds.x >= 0 && bounds.x + bounds.width <= actual.width + 1 && bounds.y + bounds.height <= actual.height + 1 && canvas.height >= 280);
    check(`No horizontal scroll ${width}x${height}`, await page.locator(".main-stage").evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  }
  await resize(1280, 820);
  await page.locator(".sidebar-brand-card").click();
  await page.locator(".clarune-about").waitFor();
  const about = await page.locator(".clarune-about").innerText();
  for (const phrase of ["CLARUNE 澄像", "AI 超清影像引擎", "用 AI 重塑图像细节。", "智能放大、降噪、锐化与纹理增强，让低清图片获得更高分辨率与更自然的视觉表现。", "Beyond Resolution.", "© EVEING", "开发者", "0399199@gmail.com"])
    check(`About: ${phrase}`, about.includes(phrase));
  await page.screenshot({ path: join(review, "02-about-zh.png") });
  await page.getByRole("button", { name: "English", exact: true }).click();
  await page.getByRole("heading", { name: "About", exact: true }).waitFor();
  check("English introduction", (await page.locator(".clarune-about").innerText()).includes("Beyond Resolution."));
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.screenshot({ path: join(review, "03-about-en-dark.png") });
  await page.locator(".license-trigger").click();
  await page.locator(".license-dialog").waitFor();
  check("License dialog branding", (await page.locator(".license-dialog").innerText()).includes("EVEING Clarune"));
  await page.screenshot({ animations: "disabled", path: join(review, "06-license-dark.png") });
  await page.locator(".dialog-close").click();
  await page.getByRole("button", { name: "Batch", exact: true }).click();
  await page.getByTestId("tool-file-input").setInputFiles([original, result]);
  await page.getByTestId("batch-select-1").waitFor();
  check("Batch queue preserved", await page.getByTestId("batch-select-1").isVisible());
  await page.screenshot({ path: join(review, "07-batch-dark.png") });
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await page.locator(".model-card").waitFor();
  await page.screenshot({ path: join(review, "08-models-dark.png") });
  await page.getByRole("button", { name: "History", exact: true }).click();
  check("History empty state preserved", await page.locator(".empty-state").isVisible());
  await page.getByRole("button", { name: "Enhance", exact: true }).click();
  await handle.waitFor();
  await page.screenshot({ path: join(review, "04-workspace-dark.png") });
  await resize(980, 680);
  check("Compact English toolbar fits", await page.locator(".viewer-toolbar").evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await page.screenshot({ path: join(review, "05-compact-en.png") });
  await page.getByTestId("original-file-input").setInputFiles(transparent);
  await page.waitForFunction(() => document.querySelector(".viewer-file-info strong")?.textContent === "transparent.png");
  const samplePixel = async () => {
    const { data, info } = await sharp(await viewport.screenshot({ scale: "css" })).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const index = (120 * info.width + 100) * info.channels;
    return [...data.subarray(index, index + 3)];
  };
  const pixelBeforeComparison = await samplePixel();
  await page.getByTestId("result-file-input").setInputFiles(transparent);
  await handle.waitFor();
  const pixelDuringComparison = await samplePixel();
  check("Transparent comparison does not double composite", pixelBeforeComparison.every((value, i) => Math.abs(value - pixelDuringComparison[i]) <= 1));
  await page.evaluate(() => {
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function () { await new Promise(resolve => setTimeout(resolve, 500)); return decode.call(this); };
  });
  await page.getByTestId("original-file-input").setInputFiles(original);
  check("Removing a comparison cannot cancel a loading original", await page.getByRole("button", { name: "Remove comparison", exact: true }).isDisabled());
  await page.waitForFunction(() => document.querySelector(".viewer-file-info strong")?.textContent === "UI-test-original.png");
  check("No renderer exceptions", errors.length === 0);
  await writeFile(join(review, "verification.json"), JSON.stringify({ passed: true, checks, errors, packaged: Boolean(process.env.CLARUNE_PREVIEW_EXE), fixture: "Synthetic images, not AI enhancement outputs", testedAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.length, review }, null, 2));
} catch (error) {
  await page.screenshot({ path: join(review, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await app.close();
}
