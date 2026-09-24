import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { _electron } = require(process.env.CLARUNE_PLAYWRIGHT_MODULE || "playwright");
const sharp = require(process.env.CLARUNE_SHARP_MODULE || "sharp");
const { PDFDocument } = require("pdf-lib");
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const review = process.env.CLARUNE_REVIEW_DIR || join(project, "UI-review-ice-tools");
const scratch = await mkdtemp(join(tmpdir(), "clarune-tools-"));
await mkdir(review, { recursive: true });
const files = Object.fromEntries(["original", "mark", "red", "blue"].map(name => [name, join(scratch, `${name}.png`)]));
await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
  <defs><linearGradient id="g"><stop stop-color="#42c6ff"/><stop offset="1" stop-color="#2547ca"/></linearGradient></defs>
  <rect width="320" height="240" fill="#ef3340"/><rect x="320" width="320" height="240" fill="#00a651"/>
  <rect y="240" width="320" height="240" fill="#1267e9"/><rect x="320" y="240" width="320" height="240" fill="#fbd534"/>
  <rect x="90" y="90" width="460" height="300" rx="35" fill="url(#g)"/>
  <circle cx="480" cy="170" r="45" fill="#e9ffff"/>
  <text x="130" y="210" font-family="sans-serif" font-size="34" fill="white">CLARUNE</text>
  <text x="130" y="252" font-family="sans-serif" font-size="16" fill="white">LOCAL IMAGE TOOLS</text>
  <path d="M130 280H510M130 290H470M130 300H430M130 310H390M130 320H350" stroke="white" stroke-width="2"/>
  <text x="130" y="355" font-family="sans-serif" font-size="12" fill="white">Synthetic QA fixture - not an AI enhancement result</text>
</svg>`)).png().toFile(files.original);
await sharp({ create: { width: 100, height: 60, channels: 4, background: "#00ffff" } }).png().toFile(files.mark);
await sharp({ create: { width: 240, height: 400, channels: 3, background: "#ef3340" } }).png().toFile(files.red);
await sharp({ create: { width: 640, height: 480, channels: 3, background: "#1267e9" } }).png().toFile(files.blue);
const hash = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const originalHash = await hash(files.original);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: process.env.CLARUNE_PREVIEW_EXE || require("electron"),
  args: process.env.CLARUNE_PREVIEW_EXE ? [`--user-data-dir=${join(scratch, "profile")}`] : [project, `--user-data-dir=${join(scratch, "profile")}`], env });
const page = await app.firstWindow();
page.setDefaultTimeout(20000);
await page.emulateMedia({ reducedMotion: "reduce" });
const errors = [], checks = [];
page.on("pageerror", error => errors.push(error.message));
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log(`PASS ${name}`); };
const nav = tool => page.getByTestId(`nav-${tool}`).click();
const field = async (id, value) => { await page.getByTestId(id).fill(String(value)); await page.getByTestId(id).press("Tab"); };
const ready = () => page.waitForFunction(() => {
  const button = document.querySelector('[data-testid="tool-export"]');
  return button && !button.disabled && !document.querySelector('.tool-processing-indicator.is-busy');
}, null, { timeout: 30000 });
const reset = async () => { await page.getByTestId("tool-reset").click(); await ready(); };
const dialog = path => app.evaluate(({ dialog }, filePath) => {
  dialog.showSaveDialog = async () => filePath ? { canceled: false, filePath } : { canceled: true, filePath: "" };
}, path);
const save = async (name, pdf = false) => {
  const path = join(scratch, name); await dialog(path);
  await page.getByTestId(pdf ? "pdf-export" : "tool-export").click();
  await page.getByTestId("tool-save-status").filter({ hasText: path }).waitFor();
  check(`Native save wrote ${name}`, (await stat(path)).size > 0);
  return path;
};
const pixel = async (path, x, y) => {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)];
};
const resizeWindow = async (width, height) => {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
  await page.waitForFunction(size => Math.abs(innerWidth - size[0]) < 5 && Math.abs(innerHeight - size[1]) < 5, [width, height]);
};
try {
  await page.getByTestId("nav-resize").waitFor();
  await page.evaluate(() => { localStorage.setItem("clarune.language", "zh-CN"); localStorage.setItem("clarune.theme", "light"); });
  await page.reload(); await resizeWindow(1440, 900);
  check("Requested subtitle", await page.locator(".brand-lockup small").innerText() === "AI 超清影像引擎");
  await page.getByTestId("original-file-input").setInputFiles(files.original);
  await page.getByTestId("output-size").locator("strong").waitFor();
  await page.getByTestId("output-quality").fill("73.4");
  check("Format compression supports decimal slider", await page.getByTestId("output-quality").inputValue() === "73.4");
  await page.getByTestId("output-quality-number").fill("61.2");
  await page.getByTestId("output-quality-number").press("Tab");
  check("Format compression accepts typed decimals", await page.getByTestId("output-quality").inputValue() === "61.2");
  await page.getByTestId("output-size").locator("strong").waitFor();
  const compressed = join(scratch, "enhance-normal-export.png"); await dialog(compressed);
  await page.getByTestId("compression-export").click();
  await page.getByTestId("compression-saved").filter({ hasText: compressed }).waitFor();
  check("Enhance export is original-sized, not fake AI", (await sharp(compressed).metadata()).width === 640);
  await page.screenshot({ path: join(review, "01-enhance-ice.png") });

  await nav("resize"); await page.getByTestId("tool-file-input").setInputFiles(files.original); await ready();
  await field("tool-width", 320); await ready();
  check("Locked dimensions", await page.getByTestId("tool-height").inputValue() === "240");
  await page.getByTestId("tool-format-webp").click(); await ready();
  const resized = await save("resized.webp"); const rm = await sharp(resized).metadata();
  check("Actual WebP dimensions and format", rm.width === 320 && rm.height === 240 && rm.format === "webp");
  await nav("compress");
  check("Source and recipe retained between tools", (await page.getByTestId("tool-preview-image").getAttribute("alt")) === "original.png");
  await page.getByTestId("tool-quality").fill("42.7"); await ready();
  check("Continuous tool compression", await page.getByTestId("tool-quality").inputValue() === "42.7");
  const compressedWebp = await save("compressed.webp");
  check("Size label equals actual bytes", (await page.getByTestId("tool-size-report").innerText()).includes(`${((await stat(compressedWebp)).size / 1024).toFixed(1)} KB`));
  await page.screenshot({ path: join(review, "02-compress.png") });

  await reset(); await page.getByTestId("tool-format-png").click(); await ready();
  await nav("crop"); await ready();
  const stage = await page.getByTestId("tool-image-stage").boundingBox();
  await page.mouse.move(stage.x + stage.width * .2, stage.y + stage.height * .2); await page.mouse.down();
  await page.mouse.move(stage.x + stage.width * .8, stage.y + stage.height * .7, { steps: 12 }); await page.mouse.up();
  check("Manual pointer crop", Number(await page.getByTestId("tool-crop-width").inputValue()) < 640 && Number(await page.getByTestId("tool-crop-width").inputValue()) > 300);
  await field("tool-crop-left", 20); await field("tool-crop-top", 30); await field("tool-crop-width", 200); await field("tool-crop-height", 150); await ready();
  const cropped = await save("crop.png"); const cm = await sharp(cropped).metadata();
  check("Exact crop pixels", cm.width === 200 && cm.height === 150);
  await page.screenshot({ path: join(review, "03-crop.png") });
  await page.getByTestId("tool-crop-preset").selectOption("1:1"); await ready();
  check("Square crop preset", await page.getByTestId("tool-crop-width").inputValue() === await page.getByTestId("tool-crop-height").inputValue());

  await reset(); await nav("rotate"); await page.getByTestId("tool-rotate-right").click(); await ready();
  const rotated = await save("rotate.png"); const rotMeta = await sharp(rotated).metadata();
  check("90 degree actual dimensions", rotMeta.width === 480 && rotMeta.height === 640);
  const rp = await pixel(rotated, 10, 10); check("Clockwise pixel mapping", rp[2] > 220 && rp[0] < 30);
  await reset(); await nav("flip"); await page.getByTestId("tool-flip-horizontal").click(); await ready();
  const flipped = await save("flip-h.png"); const fp = await pixel(flipped, 10, 10);
  check("Horizontal flip pixel mapping", fp[1] > 150 && fp[0] < 20);
  await page.getByTestId("tool-flip-horizontal").click(); await page.getByTestId("tool-flip-vertical").click(); await ready();
  const vertical = await save("flip-v.png"); const vp = await pixel(vertical, 10, 10);
  check("Vertical flip pixel mapping", vp[2] > 220 && vp[0] < 30);

  await reset(); await nav("round"); await page.getByTestId("tool-radius").fill("70"); await ready();
  const rounded = await save("rounded.png");
  check("PNG round corners transparent", (await pixel(rounded, 0, 0))[3] === 0 && (await pixel(rounded, 320, 240))[3] === 255);
  await page.getByTestId("tool-format-jpeg").click(); await ready(); const roundJpg = await save("rounded.jpg");
  check("JPEG round corners white", (await pixel(roundJpg, 0, 0)).slice(0, 3).every(channel => channel >= 250));

  await reset(); await page.getByTestId("tool-format-png").click(); await nav("watermark");
  await page.getByTestId("tool-watermark-text").fill("澄像 EVEING & <测试>");
  await page.getByTestId("tool-watermark-position").selectOption("center");
  await page.getByTestId("tool-watermark-opacity").fill("100"); await ready();
  const textMark = await save("watermark-text.png");
  check("Text watermark changes actual output", !Buffer.from(await sharp(textMark).raw().toBuffer()).equals(await sharp(files.original).ensureAlpha().raw().toBuffer()));
  await page.screenshot({ path: join(review, "04-watermark.png") });
  await page.getByTestId("tool-watermark-image-mode").click();
  await page.getByTestId("tool-watermark-file-input").setInputFiles(files.mark); await ready();
  const imageMark = await save("watermark-image.png"); const mp = await pixel(imageMark, 320, 240);
  check("Image watermark composited", mp[0] < 10 && mp[1] > 245 && mp[2] > 245);
  await dialog(imageMark); await page.getByTestId("tool-export").click();
  await page.getByTestId("tool-error").filter({ hasText: "已存在" }).waitFor();
  check("Overwrite rejected with retry available", await page.getByTestId("tool-export").isEnabled());
  await dialog(null); await page.getByTestId("tool-export").click();
  await page.getByTestId("tool-save-status").filter({ hasText: "已取消" }).waitFor();
  check("Native save cancellation handled", await page.getByTestId("tool-export").isEnabled());
  await nav("settings"); await nav("watermark");
  check("Single-image state survives leaving tools", await page.getByTestId("tool-watermark-image-mode").getAttribute("aria-pressed") === "true");

  await nav("pdf"); await page.getByTestId("pdf-file-input").setInputFiles([files.red, files.blue]);
  await page.getByTestId("pdf-item").nth(1).waitFor();
  await page.getByTestId("pdf-up-1").click();
  check("PDF queue reorder", (await page.getByTestId("pdf-item").first().innerText()).includes("blue.png"));
  const pdfPath = await save("images.pdf", true);
  const pdf = await PDFDocument.load(await readFile(pdfPath));
  check("PDF count and image-sized pages", pdf.getPageCount() === 2 && pdf.getPage(0).getWidth() === 480 && pdf.getPage(1).getHeight() === 300);
  await page.getByTestId("pdf-page-size").selectOption("a4");
  const a4Path = await save("images-a4.pdf", true); const a4 = await PDFDocument.load(await readFile(a4Path));
  check("A4 portrait pages fit images", a4.getPages().every(p => Math.abs(p.getWidth() - 595.28) < .01 && Math.abs(p.getHeight() - 841.89) < .01));
  execFileSync("pdftoppm", ["-scale-to", "600", "-png", pdfPath, join(scratch, "pdf-page")], { windowsHide: true });
  execFileSync("pdftoppm", ["-scale-to", "600", "-png", a4Path, join(scratch, "a4-page")], { windowsHide: true });
  const bluePixel = await pixel(join(scratch, "pdf-page-1.png"), 50, 50);
  const redPixel = await pixel(join(scratch, "pdf-page-2.png"), 50, 50);
  check("Rendered PDF page order and colors", bluePixel[2] > 200 && redPixel[0] > 220 && redPixel[2] < 90);
  await page.screenshot({ path: join(review, "05-pdf.png") });
  await page.getByTestId("pdf-remove-0").click(); check("PDF remove page", await page.getByTestId("pdf-item").count() === 1);
  check("Original is byte-for-byte unchanged", await hash(files.original) === originalHash);

  await nav("settings"); await page.getByRole("button", { name: "English", exact: true }).click();
  await nav("crop"); check("Tools switch language immediately", await page.getByRole("heading", { name: "Crop image", exact: true }).isVisible());
  for (const [width, height] of [[980, 680], [1440, 900]]) {
    await resizeWindow(width, height);
    check(`No horizontal overflow at ${width}`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector(".main-stage").scrollWidth <= document.querySelector(".main-stage").clientWidth + 1));
    const cb = await page.locator(".tool-canvas").boundingBox();
    check(`Canvas on screen at ${width}`, cb.y + cb.height <= await page.evaluate(() => innerHeight) + 1 && cb.width > 300);
  }
  await resizeWindow(980, 680); await nav("watermark");
  await page.getByTestId("tool-export").scrollIntoViewIfNeeded();
  check("Small-window export is reachable", await page.getByTestId("tool-export").isVisible());
  await page.screenshot({ path: join(review, "06-compact-en.png") });
  await nav("settings"); await page.getByRole("button", { name: "Dark", exact: true }).click(); await nav("round");
  await page.screenshot({ path: join(review, "07-dark.png") });
  check("No renderer exceptions", errors.length === 0);
  const report = { passed: true, checks, errors, scratch, packaged: Boolean(process.env.CLARUNE_PREVIEW_EXE), testedAt: new Date().toISOString(), fixture: "Synthetic local-tool test images; not AI output" };
  await writeFile(join(review, "tools-verification.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.length, scratch, review }, null, 2));
} catch (error) {
  await page.screenshot({ path: join(review, "failure.png") }).catch(() => {});
  console.error({ scratch, errors }); throw error;
} finally { await app.close(); }
