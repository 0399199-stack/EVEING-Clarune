import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(`${project}/package.json`);
const { _electron } = require(process.env.CLARUNE_PLAYWRIGHT_MODULE || "playwright");
const sharp = require(process.env.CLARUNE_SHARP_MODULE || "sharp");
const scratch = await mkdtemp(join(tmpdir(), "clarune-history-fixes-"));
const review = process.env.CLARUNE_REVIEW_DIR || join(project, "UI-review-fixes", "history");
await mkdir(review, { recursive: true });
const original = join(scratch, "black.png"), red = join(scratch, "red-mark.png"), blue = join(scratch, "blue-mark.png");
for (const [path, width, height, background] of [[original, 800, 600, "black"], [red, 80, 40, "red"], [blue, 40, 80, "blue"]]) await sharp({ create: { width, height, channels: 4, background } }).png().toFile(path);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: process.env.CLARUNE_PREVIEW_EXE || require("electron"),
  args: process.env.CLARUNE_PREVIEW_EXE ? [`--user-data-dir=${join(scratch, "profile")}`] : [project, `--user-data-dir=${join(scratch, "profile")}`], env });
const page = await app.firstWindow(); page.setDefaultTimeout(25000); await page.emulateMedia({ reducedMotion: "reduce" });
const checks = [], errors = [];
page.on("pageerror", error => errors.push(error.message));
const check = (name, actual) => { assert.ok(actual, name); checks.push(name); console.log(`PASS ${name}`); };
const ready = () => page.waitForFunction(() => document.querySelector('[data-testid="tool-export"]') && !document.querySelector('[data-testid="tool-export"]').disabled && !document.querySelector('.tool-processing-indicator.is-busy'));
const changePreview = async action => {
  const before = await page.getByTestId("tool-preview-image").getAttribute("src"); await action();
  await page.waitForFunction(previous => document.querySelector('[data-testid="tool-preview-image"]')?.src !== previous && !document.querySelector('.tool-processing-indicator.is-busy'), before);
  await ready();
};
const edit = id => changePreview(() => page.getByTestId(id).click());
const loadMark = path => changePreview(() => page.getByTestId("tool-watermark-file-input").setInputFiles(path));
const mode = async () => await page.getByTestId("tool-watermark-image-mode").getAttribute("aria-pressed") === "true";
const getImage = async selector => {
  const encoded = await page.locator(selector).evaluate(async node => {
    await node.decode(); const canvas = document.createElement("canvas"); canvas.width = node.naturalWidth; canvas.height = node.naturalHeight;
    canvas.getContext("2d").drawImage(node, 0, 0); return canvas.toDataURL("image/png").split(",")[1];
  });
  const { data, info } = await sharp(Buffer.from(encoded, "base64")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { ...info, data };
};
const preview = async () => Buffer.from((await getImage('[data-testid="tool-preview-image"]')).data);
const redThumbnail = await sharp(red).ensureAlpha().raw().toBuffer();
const field = async (id, value) => { await page.getByTestId(id).fill(String(value)); await page.getByTestId(id).press("Tab"); await ready(); };
try {
  await page.getByTestId("nav-watermark").click(); await page.getByTestId("tool-file-input").setInputFiles(original); await ready();
  await page.getByTestId("tool-watermark-image-mode").click(); await loadMark(red); const redPixels = await preview();
  await page.waitForTimeout(700); // Separate user edits from the intentional 650 ms history coalescing window.
  await loadMark(blue); const bluePixels = await preview();
  check("Replacing a watermark changes the encoded preview", !redPixels.equals(bluePixels));
  await edit("tool-undo");
  check("Undo watermark replacement restores actual red pixels", redPixels.equals(await preview()));
  check("Undo watermark replacement restores picker thumbnail", Buffer.from((await getImage('[data-testid="tool-watermark-choose"] img')).data).equals(redThumbnail));
  await field("tool-watermark-scale-input", 25);
  const scaled = (await getImage('[data-testid="tool-preview-image"]')).data;
  let redCount = 0, blueCount = 0; for (let i = 0; i < scaled.length; i += 4) { if (scaled[i] > 100 && scaled[i + 2] < 40) redCount++; if (scaled[i + 2] > 100 && scaled[i] < 40) blueCount++; }
  check("Editing after undo keeps the restored watermark asset", redCount > 1000 && blueCount === 0);
  await edit("tool-reset"); await edit("tool-undo");
  check("Undo reset restores image watermark controls", await mode());
  check("Undo reset restores image thumbnail", Buffer.from((await getImage('[data-testid="tool-watermark-choose"] img')).data).equals(redThumbnail));
  await edit("tool-watermark-text-mode"); await edit("tool-undo");
  check("Undo mode change restores the image editing mode", await mode());
  await edit("tool-redo"); check("Redo mode change restores text editing mode", !(await mode()));
  await page.getByTestId("tool-reset").click(); await ready(); await page.getByTestId("nav-rotate").click(); await ready(); await field("tool-rotation-input", 20);
  await page.getByTestId("tool-applied-edits").locator("summary").click(); await changePreview(() => page.getByTestId("edit-enabled-rotation").uncheck());
  const offMeta = await getImage('[data-testid="tool-preview-image"]'); check("Disabled rotation keeps original dimensions", offMeta.width === 800 && offMeta.height === 600);
  await field("tool-rotation-input", 30); check("Changing a disabled parameter reenables that edit", await page.getByTestId("edit-enabled-rotation").isChecked());
  await edit("tool-undo"); check("Undo restores edit-disabled state and its prior value", !(await page.getByTestId("edit-enabled-rotation").isChecked()) && Number(await page.getByTestId("tool-rotation-input").inputValue()) === 20);
  const output = join(scratch, "immediate-export.png");
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, output);
  await page.getByTestId("tool-rotation-input").fill("37.45");
  await page.getByTestId("tool-export").click();
  await page.getByTestId("tool-save-status").filter({ hasText: output }).waitFor(); await ready();
  const expected = await sharp(original).rotate(37.5).png().toBuffer({ resolveWithObject: true }), actual = await sharp(output).metadata();
  check("Immediate first-click export uses latest normalized angle during pending preview", actual.width === expected.info.width && actual.height === expected.info.height);
  await page.getByTestId("tool-reset").click(); await ready(); await page.getByTestId("tool-rotate-right").click(); await ready();
  await page.getByTestId("nav-watermark").click(); await ready(); await page.getByTestId("tool-watermark-image-mode").click();
  await loadMark(red);
  await page.getByTestId("tool-watermark-position").selectOption("custom"); await ready();
  await page.getByTestId("tool-watermark-unit").selectOption("pixels");
  await field("tool-watermark-x", 100); await field("tool-watermark-y", 200);
  const positioned = await page.getByTestId("tool-watermark-box").evaluate(node => ({ left: parseFloat(node.style.left), top: parseFloat(node.style.top) }));
  check("Pixel XY remains exact while preview updates on a rotated image", positioned.left === 100 && positioned.top === 200);
  check("No renderer exceptions", errors.length === 0);
  await writeFile(join(review, "history-fixes.json"), JSON.stringify({ passed: true, checks, errors, scratch, packaged: Boolean(process.env.CLARUNE_PREVIEW_EXE), testedAt: new Date().toISOString() }, null, 2));
} catch (error) {
  await page.screenshot({ path: join(review, "failure.png") }).catch(() => {});
  await writeFile(join(review, "failure.json"), JSON.stringify({ passed: false, checks, errors, scratch, error: String(error), stack: error.stack }, null, 2)); throw error;
} finally { await app.close(); }
