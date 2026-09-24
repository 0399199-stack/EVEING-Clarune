import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { _electron } = require(process.env.CLARUNE_PLAYWRIGHT_MODULE || "playwright");
const sharp = require(process.env.CLARUNE_SHARP_MODULE || "sharp");
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const review = process.env.CLARUNE_REVIEW_DIR || join(project, "UI-review-batch-v2");
const scratch = await mkdtemp(join(tmpdir(), "clarune-canvas-v2-"));
await mkdir(review, { recursive: true });
const source = join(scratch, "canvas-original.png"), mark = join(scratch, "white-logo.png");
await sharp({ create: { width: 1024, height: 768, channels: 3, background: "#000000" } }).png().toFile(source);
await sharp({ create: { width: 200, height: 100, channels: 4, background: "#ffffff" } }).png().toFile(mark);
const hash = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const initialHash = await hash(source);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: process.env.CLARUNE_PREVIEW_EXE || require("electron"),
  args: process.env.CLARUNE_PREVIEW_EXE ? [`--user-data-dir=${join(scratch, "profile")}`] : [project, `--user-data-dir=${join(scratch, "profile")}`], env });
const page = await app.firstWindow();
page.setDefaultTimeout(20000);
await page.emulateMedia({ reducedMotion: "reduce" });
const checks = [], errors = [], artifacts = [];
page.on("pageerror", error => errors.push(error.message));
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log(`PASS ${name}`); };
const nav = name => page.getByTestId(`nav-${name}`).click();
const field = async (id, value) => { await page.getByTestId(id).fill(String(value)); await page.getByTestId(id).press("Tab"); };
const ready = () => page.waitForFunction(() => {
  const button = document.querySelector('[data-testid="tool-export"]');
  return button && !button.disabled && !document.querySelector(".tool-processing-indicator.is-busy");
}, null, { timeout: 40000 });
const reset = async () => { await page.getByTestId("tool-reset").click(); await ready(); };
const zoom = async value => {
  await page.getByTestId("tool-zoom-input").fill(String(value));
  assert.equal(Number(await page.getByTestId("tool-zoom-input").inputValue()), value);
  await page.getByTestId("tool-zoom-input").press("Tab");
  await page.waitForFunction(target => Math.abs(Number(document.querySelector('[data-testid="tool-image-surface"]').dataset.zoom) - target) < .0001, value / 100);
};
const zoomValue = async () => Number(await page.getByTestId("tool-image-surface").getAttribute("data-zoom"));
const surface = () => page.getByTestId("tool-image-surface").boundingBox();
const stage = () => page.getByTestId("tool-image-stage").boundingBox();
const save = async name => {
  const path = join(scratch, name);
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, path);
  await ready(); await page.getByTestId("tool-export").click();
  await page.getByTestId("tool-save-status").filter({ hasText: path }).waitFor();
  await ready();
  check(`Native image save: ${name}`, (await stat(path)).size > 0); artifacts.push(path); return path;
};
const paired = async (id, numeric, slider, image = true) => {
  await field(`${id}-input`, numeric); if (image) await ready();
  check(`${id} numeric updates slider`, Math.abs(Number(await page.getByTestId(id).inputValue()) - numeric) < .001);
  await page.getByTestId(id).fill(String(slider)); if (image) await ready();
  await page.waitForFunction(({ id, value }) => Math.abs(Number(document.querySelector(`[data-testid="${id}-input"]`).value) - value) < .001, { id, value: slider });
  check(`${id} slider updates numeric`, Math.abs(Number(await page.getByTestId(`${id}-input`).inputValue()) - slider) < .001);
};
async function overlayBounds() {
  return page.getByTestId("tool-watermark-box").evaluate(node => ({ left: parseFloat(node.style.left), top: parseFloat(node.style.top), width: parseFloat(node.style.width), height: parseFloat(node.style.height) }));
}
async function whiteBounds(path) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width, top = info.height, right = -1, bottom = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const p = (y * info.width + x) * 4;
    if (data[p] > 200 && data[p + 1] > 200 && data[p + 2] > 200 && data[p + 3] > 200) {
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}
const sameBounds = (a, b, tolerance = 1) => ["left", "top", "width", "height"].every(key => Math.abs(a[key] - b[key]) <= tolerance);
async function screenshot(name) { const path = join(review, name); await page.screenshot({ path }); artifacts.push(path); }
try {
  await page.getByTestId("nav-resize").waitFor();
  await page.evaluate(() => { localStorage.setItem("clarune.language", "zh-CN"); localStorage.setItem("clarune.theme", "light"); });
  await page.reload(); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 980));
  await nav("resize"); await page.getByTestId("tool-file-input").setInputFiles(source); await ready();
  for (const tool of ["resize", "compress", "crop", "watermark", "round", "rotate", "flip"]) {
    await nav(tool); await ready(); await page.getByTestId("tool-zoom-fit").click();
    const before = await zoomValue(), box = await surface();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, -160);
    await page.waitForFunction(initial => Number(document.querySelector('[data-testid="tool-image-surface"]').dataset.zoom) > initial, before);
    const after = await zoomValue(); check(`${tool}: mouse wheel zooms in`, after > before);
    await page.mouse.wheel(0, 80);
    await page.waitForFunction(initial => Number(document.querySelector('[data-testid="tool-image-surface"]').dataset.zoom) < initial, after);
    check(`${tool}: mouse wheel zooms out`, await zoomValue() < after);
  }
  await zoom(175.5); check("Zoom supports typed decimal percentages", Math.abs(await zoomValue() - 1.755) < .0001);
  await page.getByTestId("tool-zoom-input").focus();
  const wheelBox = await surface(); await page.mouse.move(wheelBox.x + wheelBox.width / 2, wheelBox.y + wheelBox.height / 2); await page.mouse.wheel(0, -80);
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="tool-image-surface"]').dataset.zoom) > 1.755);
  check("Wheel zoom updates a previously focused numeric field", Math.abs(Number(await page.getByTestId("tool-zoom-input").inputValue()) / 100 - await zoomValue()) < .001);
  await page.getByTestId("tool-zoom-actual").click(); check("1:1 zoom uses source pixels", Math.abs(await zoomValue() - 1) < .0001);
  await page.getByTestId("tool-zoom-fit").click();
  let viewport = await surface(), fitted = await stage();
  check("Fit includes the complete image", fitted.width <= viewport.width + 1 && fitted.height <= viewport.height + 1);
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.getByTestId("tool-zoom-fit").click(); await zoom(200 + attempt / 10);
    check(`Rapid fit then numeric zoom preserves input (${attempt + 1}/5)`, Math.abs(await zoomValue() - (2 + attempt / 1000)) < .0001);
  }
  await zoom(200); viewport = await surface(); const beforePan = await stage();
  const center = { x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 };
  await page.mouse.move(center.x, center.y); await page.mouse.down(); await page.mouse.move(center.x + 50, center.y + 30, { steps: 8 });
  const panned = await stage(); check("Zoomed preview supports pixel-accurate pan", Math.abs(panned.x - beforePan.x - 50) < 2 && Math.abs(panned.y - beforePan.y - 30) < 2);
  await page.mouse.wheel(0, -70); await page.waitForFunction(() => Number(document.querySelector('[data-testid="tool-image-surface"]').dataset.zoom) > 2);
  const afterWheel = await zoomValue(); await page.mouse.move(center.x + 80, center.y + 40); await page.mouse.up();
  check("Wheel during pan clears stale pan scale", Math.abs(await zoomValue() - afterWheel) < .0001);

  await nav("crop"); await reset(); await zoom(150);
  viewport = await surface(); const beforeSpacePan = await stage();
  await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
  await page.getByTestId("tool-image-surface").focus();
  await page.keyboard.down("Space"); await page.mouse.down();
  await page.mouse.move(viewport.x + viewport.width / 2 + 35, viewport.y + viewport.height / 2 + 25, { steps: 6 });
  await page.mouse.up(); await page.keyboard.up("Space");
  const cropStage = await stage();
  check("Space-drag pans crop canvas without creating a crop", Math.abs(cropStage.x - beforeSpacePan.x - 35) < 2 && await page.getByTestId("tool-crop-width").inputValue() === "1024");
  const cx = (viewport.x + viewport.width / 2 - cropStage.x) / 1.5, cy = (viewport.y + viewport.height / 2 - cropStage.y) / 1.5;
  const expectedCrop = { left: Math.round(cx - 70), top: Math.round(cy - 45), width: 140, height: 90 };
  await page.mouse.move(cropStage.x + expectedCrop.left * 1.5, cropStage.y + expectedCrop.top * 1.5); await page.mouse.down();
  await page.mouse.move(cropStage.x + (expectedCrop.left + expectedCrop.width) * 1.5, cropStage.y + (expectedCrop.top + expectedCrop.height) * 1.5, { steps: 12 }); await page.mouse.up(); await ready();
  for (const key of Object.keys(expectedCrop)) check(`Zoomed crop ${key} matches original pixels`, Math.abs(Number(await page.getByTestId(`tool-crop-${key}`).inputValue()) - expectedCrop[key]) <= 1);
  const cropPath = await save("crop-after-zoom.png"), cropMeta = await sharp(cropPath).metadata();
  check("Zoomed crop exports real selected dimensions", Math.abs(cropMeta.width - expectedCrop.width) <= 1 && Math.abs(cropMeta.height - expectedCrop.height) <= 1);
  await screenshot("canvas-01-zoomed-crop.png"); await reset();

  await nav("watermark"); await page.getByTestId("tool-watermark-text").fill("Clarune WAVE 123");
  await field("tool-watermark-font-size", 64); await page.getByTestId("tool-watermark-position").selectOption("center");
  await paired("tool-watermark-opacity", 42.3, 100);
  await page.waitForFunction(() => document.querySelector('[data-testid="tool-watermark-font-family"]').options.length > 2);
  const fonts = await page.getByTestId("tool-watermark-font-family").locator("option").evaluateAll(nodes => nodes.map(node => node.value).filter(Boolean));
  check("Watermark picker lists actual installed font families", fonts.length > 10);
  const first = fonts.find(name => name === "Arial") ?? fonts[0];
  const second = fonts.find(name => name === "Times New Roman") ?? fonts.find(name => name !== first);
  await page.getByTestId("tool-watermark-font-family").selectOption(first); await ready(); const firstFont = await save("font-one.png");
  await page.getByTestId("tool-watermark-font-family").selectOption(second); await ready(); const secondFont = await save("font-two.png");
  check(`Installed font selection changes encoded pixels (${first} / ${second})`, !(await sharp(firstFont).raw().toBuffer()).equals(await sharp(secondFont).raw().toBuffer()));
  await page.getByTestId("tool-watermark-position").selectOption("custom"); await field("tool-watermark-x", 25.5); await field("tool-watermark-y", 35.5); await ready();
  let bounds = await overlayBounds();
  check("Typed custom X uses available watermark travel", Math.abs(bounds.left - Math.round((1024 - bounds.width) * .255)) <= 1);
  check("Typed custom Y uses available watermark travel", Math.abs(bounds.top - Math.round((768 - bounds.height) * .355)) <= 1);
  await screenshot("canvas-02-font-custom-position.png");

  await page.getByTestId("tool-watermark-image-mode").click();
  check("Image watermark recommends transparent white images or logos", /透明.*白色.*Logo/.test(await page.locator(".tool-edit-group").innerText()));
  await page.getByTestId("tool-watermark-file-input").setInputFiles(mark); await ready();
  await paired("tool-watermark-scale", 24.7, 25); await field("tool-watermark-x", 50); await field("tool-watermark-y", 50); await ready();
  bounds = await overlayBounds();
  const beforeDrag = await save("image-watermark-custom.png");
  check("Image watermark overlay equals encoded white-pixel bounds", sameBounds(await whiteBounds(beforeDrag), bounds));
  await zoom(200); const watermarkBox = await page.getByTestId("tool-watermark-box").boundingBox();
  await page.mouse.move(watermarkBox.x + watermarkBox.width / 2, watermarkBox.y + watermarkBox.height / 2); await page.mouse.down();
  await page.mouse.move(watermarkBox.x + watermarkBox.width / 2 + 80, watermarkBox.y + watermarkBox.height / 2 + 48, { steps: 12 });
  const ghost = await overlayBounds(); check("Watermark ghost follows drag in image coordinates", Math.abs(ghost.left - bounds.left - 40) <= 1 && Math.abs(ghost.top - bounds.top - 24) <= 1);
  await page.mouse.up(); await ready();
  const moved = await overlayBounds();
  check("Dragged watermark coordinates persist after encoding", sameBounds(moved, ghost));
  const x = Number(await page.getByTestId("tool-watermark-x").inputValue()), y = Number(await page.getByTestId("tool-watermark-y").inputValue());
  check("Dragging updates numeric XY percentages", Math.abs(x / 100 - moved.left / (1024 - moved.width)) < .001 && Math.abs(y / 100 - moved.top / (768 - moved.height)) < .001);
  const dragged = await save("image-watermark-drag.png"); check("Dragged watermark export matches the real canvas bounds", sameBounds(await whiteBounds(dragged), moved));
  await screenshot("canvas-03-watermark-drag.png");

  await reset(); await nav("rotate"); await paired("tool-rotation", -37.4, 21.6); await reset();
  await nav("round"); await paired("tool-radius", 63, 80); await reset();
  await nav("compress"); await paired("tool-quality", 67.3, 84.6); await reset();
  await nav("pdf"); await paired("pdf-quality", 66.6, 83.2, false);
  check("Original image is preserved byte-for-byte", await hash(source) === initialHash);
  await nav("settings"); await page.getByRole("button", { name: "English", exact: true }).click(); await nav("watermark");
  check("Canvas controls switch language", await page.getByTestId("tool-zoom-fit").innerText() === "Fit");
  check("No renderer exceptions", errors.length === 0);
  const report = { passed: true, checks, errors, artifacts, scratch, fonts: { count: fonts.length, verified: [first, second] },
    packaged: Boolean(process.env.CLARUNE_PREVIEW_EXE), testedAt: new Date().toISOString(), fixture: "Synthetic black image and white rectangle; no AI output or external images" };
  await writeFile(join(review, "canvas-verification.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.length, scratch, review }, null, 2));
} catch (error) {
  await screenshot("canvas-failure.png").catch(() => {});
  await writeFile(join(review, "canvas-failure.json"), JSON.stringify({ passed: false, checks, errors, scratch, failure: String(error), stack: error.stack }, null, 2));
  console.error({ scratch, checks: checks.length, errors }); throw error;
} finally { await app.close(); }
