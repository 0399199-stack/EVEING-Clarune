import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(`${project}/package.json`);
const { _electron } = require(process.env.CLARUNE_PLAYWRIGHT_MODULE || "playwright");
const sharp = require(process.env.CLARUNE_SHARP_MODULE || "sharp");
const scratch = await mkdtemp(join(tmpdir(), "clarune-canvas-fixes-"));
const review = process.env.CLARUNE_REVIEW_DIR || join(project, "UI-review-fixes", "canvas");
await mkdir(review, { recursive: true });
const original = join(scratch, "black-original.png"), logo = join(scratch, "white-logo.png");
await sharp({ create: { width: 800, height: 600, channels: 3, background: "#000000" } }).png().toFile(original);
await sharp({ create: { width: 80, height: 40, channels: 4, background: "#ffffff" } }).png().toFile(logo);
const originalBytes = await readFile(original);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: process.env.CLARUNE_PREVIEW_EXE || require("electron"),
  args: process.env.CLARUNE_PREVIEW_EXE ? [`--user-data-dir=${join(scratch, "profile")}`] : [project, `--user-data-dir=${join(scratch, "profile")}`], env });
const page = await app.firstWindow(); page.setDefaultTimeout(25000);
await page.emulateMedia({ reducedMotion: "reduce" });
const checks = [], errors = [];
page.on("pageerror", error => errors.push(error.message));
const check = (name, actual) => { assert.ok(actual, name); checks.push(name); console.log(`PASS ${name}`); };
const nav = id => page.getByTestId(`nav-${id}`).click();
const ready = () => page.waitForFunction(() => {
  const button = document.querySelector('[data-testid="tool-export"]');
  return button && !button.disabled && !document.querySelector('.tool-processing-indicator.is-busy');
}, null, { timeout: 40000 });
const field = async (id, value) => { await page.getByTestId(id).fill(String(value)); await page.getByTestId(id).press("Tab"); await ready(); };
const crop = async () => Object.fromEntries(await Promise.all(["left", "top", "width", "height"].map(async key => [key, Number(await page.getByTestId(`tool-crop-${key}`).inputValue())])));
const close = (a, b, tolerance = 1) => Object.keys(b).every(key => Math.abs(a[key] - b[key]) <= tolerance);
async function imageDrag(from, to) {
  const box = await page.getByTestId("tool-image-stage").boundingBox(), scale = box.width / 800;
  await page.mouse.move(box.x + from.x * scale, box.y + from.y * scale); await page.mouse.down();
  await page.mouse.move(box.x + to.x * scale, box.y + to.y * scale, { steps: 10 }); await page.mouse.up(); await ready();
}
async function resize(corner, dx, dy) {
  const box = await page.getByTestId(`tool-crop-${corner}-handle`).boundingBox();
  const scale = Number(await page.getByTestId("tool-image-surface").getAttribute("data-zoom"));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx * scale, box.y + box.height / 2 + dy * scale, { steps: 10 });
  await page.mouse.up(); await ready();
}
async function markBounds() {
  return page.getByTestId("tool-watermark-box").evaluate(node => ({ left: parseFloat(node.style.left), top: parseFloat(node.style.top), width: parseFloat(node.style.width), height: parseFloat(node.style.height) }));
}
try {
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(1500, 1000); win.webContents.setBackgroundThrottling(false); });
  await nav("crop"); await page.getByTestId("tool-file-input").setInputFiles(original); await ready();
  await page.getByTestId("tool-zoom-fit").click();
  await imageDrag({ x: 100, y: 100 }, { x: 500, y: 350 });
  check("Full-image initial crop still supports drawing a new region", close(await crop(), { left: 100, top: 100, width: 400, height: 250 }));
  await imageDrag({ x: 300, y: 200 }, { x: 350, y: 240 });
  check("Crop body drag moves selection without resizing", close(await crop(), { left: 150, top: 140, width: 400, height: 250 }));
  const canceledHandle = await page.getByTestId("tool-crop-bottom-right-handle").boundingBox();
  await page.mouse.move(canceledHandle.x + canceledHandle.width / 2, canceledHandle.y + canceledHandle.height / 2); await page.mouse.down();
  await page.mouse.move(canceledHandle.x + 30, canceledHandle.y + 30, { steps: 4 }); await page.keyboard.press("Escape"); await page.mouse.up();
  check("Escape cancels a focused corner-handle drag without committing", close(await crop(), { left: 150, top: 140, width: 400, height: 250 }));
  await resize("bottom-right", 80, 50);
  check("Corner handle resizes without jumping at grab offset", close(await crop(), { left: 150, top: 140, width: 480, height: 300 }));
  await page.getByTestId("tool-crop-top-left-handle").focus(); await page.keyboard.press("Shift+ArrowRight"); await ready();
  check("Crop corner supports Shift+arrow keyboard adjustments", close(await crop(), { left: 160, top: 140, width: 470, height: 300 }));
  await page.getByTestId("tool-crop-box").focus(); await page.keyboard.press("ArrowDown"); await ready();
  check("Crop selection supports one-pixel keyboard moves", close(await crop(), { left: 160, top: 141, width: 470, height: 300 }));
  await page.getByTestId("tool-crop-preset").selectOption("16:9"); await ready(); const ratioInitial = await crop();
  await resize("bottom-right", -160, 0); const ratioEnd = await crop();
  check("Single-axis shrink honors 16:9 ratio and opposite anchor", ratioEnd.width < ratioInitial.width && Math.abs(ratioEnd.width - ratioEnd.height * 16 / 9) <= 1 && ratioEnd.left === ratioInitial.left && ratioEnd.top === ratioInitial.top);
  await page.screenshot({ path: join(review, "crop-handles.png") });
  await page.keyboard.down("Alt"); await imageDrag({ x: 150, y: 130 }, { x: 310, y: 220 }); await page.keyboard.up("Alt");
  check("Alt-drag can redraw inside a prior selection", close(await crop(), { left: 150, top: 130, width: 160, height: 90 }));
  await page.getByTestId("tool-reset").click(); await ready(); await nav("watermark");
  await page.getByTestId("tool-watermark-image-mode").click(); await page.getByTestId("tool-watermark-file-input").setInputFiles(logo); await ready();
  await field("tool-watermark-scale-input", 10); await field("tool-watermark-opacity-input", 100);
  await page.getByTestId("tool-watermark-position").selectOption("custom"); await ready();
  await field("tool-watermark-x", 25); await field("tool-watermark-y", 40);
  await page.getByTestId("tool-watermark-snap").uncheck(); await page.getByTestId("tool-watermark-guide").check();
  check("Optional watermark margin guide is visible", await page.getByTestId("tool-watermark-margin-guide").isVisible());
  await page.getByTestId("tool-watermark-guide").uncheck();
  await page.getByTestId("tool-zoom-fit").click();
  await page.waitForFunction(() => {
    const layers = [...document.querySelectorAll('.image-tool-live-watermark img')];
    return layers.length === 2 && layers.every(img => img.complete && img.naturalWidth > 0);
  });
  const before = await markBounds();
  const markBox = await page.getByTestId("tool-watermark-box").boundingBox();
  const scale = Number(await page.getByTestId("tool-image-surface").getAttribute("data-zoom"));
  await page.mouse.move(markBox.x + markBox.width / 2, markBox.y + markBox.height * .8); await page.mouse.down();
  await page.mouse.move(markBox.x + markBox.width / 2 + 180 * scale, markBox.y + markBox.height * .8 + 100 * scale, { steps: 12 });
  const during = await markBounds();
  check("Watermark box follows drag before mouse release", close(during, { ...before, left: before.left + 180, top: before.top + 100 }));
  const imageShot = await page.getByTestId("tool-image-stage").screenshot({ path: join(review, "watermark-during-drag.png") });
  const pixels = await sharp(imageShot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const sample = rect => {
    const x = Math.round((rect.left + rect.width * .75) * pixels.info.width / 800);
    const y = Math.round((rect.top + rect.height * .8) * pixels.info.height / 600);
    return [...pixels.data.subarray((y * pixels.info.width + x) * 3, (y * pixels.info.width + x) * 3 + 3)];
  };
  const oldRgb = sample(before), movedRgb = sample(during);
  check("Actual watermark pixels move live (old position returns to black)", oldRgb.every(channel => channel < 50));
  check("Actual watermark pixels are white at new position before release", movedRgb.every(channel => channel > 200));
  await page.mouse.up(); await ready();
  check("Live watermark position equals committed rendered position", close(await markBounds(), during));
  const output = join(scratch, "dragged-watermark.png");
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, output);
  await page.getByTestId("tool-export").click(); await page.getByTestId("tool-save-status").filter({ hasText: output }).waitFor(); await ready();
  const exported = await sharp(output).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (Math.round(during.top + during.height / 2) * 800 + Math.round(during.left + during.width / 2)) * 3;
  check("Exported pixels match the live-drag result", [...exported.data.subarray(offset, offset + 3)].every(channel => channel > 240));
  await page.getByTestId("tool-watermark-snap").check();
  const current = await page.getByTestId("tool-watermark-box").boundingBox();
  await page.mouse.move(current.x + current.width / 2, current.y + current.height * .8); await page.mouse.down();
  await page.mouse.move(current.x + current.width / 2 + (2 - during.left) * scale, current.y + current.height * .8, { steps: 10 });
  const snapped = await markBounds(); check("Optional snapping reaches the exact image edge", snapped.left === 0);
  await page.mouse.up(); await ready(); check("Snapped position survives encoding", (await markBounds()).left === 0);
  check("Original source is unchanged", originalBytes.equals(await readFile(original)));
  check("No renderer exceptions", errors.length === 0);
  await writeFile(join(review, "canvas-fixes.json"), JSON.stringify({ passed: true, checks, errors, scratch, pixels: { oldRgb, movedRgb }, packaged: Boolean(process.env.CLARUNE_PREVIEW_EXE), testedAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.length, review }));
} catch (error) {
  await page.screenshot({ path: join(review, "failure.png") }).catch(() => {});
  await writeFile(join(review, "failure.json"), JSON.stringify({ passed: false, checks, errors, scratch, error: String(error), stack: error.stack }, null, 2));
  throw error;
} finally { await app.close(); }
