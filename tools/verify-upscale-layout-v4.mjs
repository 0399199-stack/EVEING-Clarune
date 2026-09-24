import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(project, 'package.json'));
const { _electron } = require(process.env.CLARUNE_PLAYWRIGHT_MODULE || 'playwright');
const sharp = require(process.env.CLARUNE_SHARP_MODULE || 'sharp');
const scratch = await mkdtemp(join(tmpdir(), 'clarune-upscale-layout-v4-'));
await mkdir(join(scratch, 'profile'));
await writeFile(join(scratch, 'profile', 'upscale-runtime.json'), JSON.stringify({ directory: join(scratch, 'missing-runtime'), localOnly: true }));
const review = process.env.CLARUNE_REVIEW_DIR || join(project, 'UI-review-upscale-v4/layout');
await mkdir(review, { recursive: true });
const fixture = join(scratch, 'CLARUNE 澄像 · 低清输入 🧊.png');
await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><defs><linearGradient id="g"><stop stop-color="#297cbc"/><stop offset="1" stop-color="#b4eee7"/></linearGradient></defs><rect width="320" height="240" fill="url(#g)"/><circle cx="220" cy="85" r="46" fill="#ecfbff"/><text x="25" y="195" font-size="25" fill="#183b63">CLARUNE AI</text></svg>')).png().toFile(fixture);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const exe = process.env.CLARUNE_PREVIEW_EXE || require('electron');
const app = await _electron.launch({ executablePath: exe, args: [...(process.env.CLARUNE_PREVIEW_EXE ? [] : [project]), `--user-data-dir=${join(scratch, 'profile')}`], env });
const page = await app.firstWindow(); page.setDefaultTimeout(20000); await page.emulateMedia({ reducedMotion: 'reduce' });
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
const checks = [], errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  for (const runtimeState of process.env.CLARUNE_RUNTIME_DIRECTORY ? ['missing', 'ready'] : ['missing']) {
  if (runtimeState === 'ready') {
    await page.getByTestId('nav-batch').click();
    await page.getByTestId('batch-tool-upscale').click();
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, process.env.CLARUNE_RUNTIME_DIRECTORY);
    await page.getByTestId('tool-upscale-runtime-select').click();
    await page.waitForFunction(() => /Connected|已连接/.test(document.querySelector('[data-testid="tool-upscale-status"]')?.textContent ?? ''));
  }
  for (const language of ['zh-CN', 'en-US']) for (const theme of ['light', 'dark']) {
    await page.getByTestId('nav-settings').waitFor();
    await page.evaluate(({ language, theme }) => { localStorage.setItem('clarune.language', language); localStorage.setItem('clarune.theme', theme); }, { language, theme });
    await page.reload(); await page.getByTestId('nav-batch').click();
    await page.getByTestId('batch-tool-upscale').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="tool-upscale-runtime-select"]')?.disabled);
    if (runtimeState === 'ready') assert.match(await page.getByTestId('tool-upscale-status').innerText(), /Connected|已连接/);
    await page.getByTestId('tool-file-input').setInputFiles([fixture, fixture, fixture]);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="batch-item"]').length === 3 && !document.querySelector('.tool-processing-indicator.is-busy'));
    assert.equal(await page.getByTestId('batch-tool-upscale').getAttribute('aria-pressed'), 'true');
    for (const [width, height] of [[980, 680], [1280, 820], [1600, 1000]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const geometry = await page.evaluate(() => {
        const box = selector => { const e = document.querySelector(selector), r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
        return { viewport: [innerWidth, innerHeight], page: [document.body.scrollWidth, document.body.scrollHeight],
          batch: box('[data-testid="tool-batch-export"]'), single: box('[data-testid="tool-export"]'),
          preview: box('[data-testid="tool-image-surface"]'), runtime: box('[data-testid="tool-upscale-runtime"]'),
          fields: box('.tool-inspector fieldset'), scroller: box('.tool-inspector-scroll'), queue: box('.tool-image-queue'), canvas: box('.tool-canvas'), firstTab: document.querySelector('.tool-batch-tools button')?.dataset.testid };
      });
      const name = `${runtimeState}-${language}-${theme}-${width}`;
      checks.push({ name, ...geometry });
      assert.ok(geometry.page[0] <= width + 1 && geometry.page[1] <= height + 2, name + ' page overflow');
      for (const control of [geometry.batch, geometry.single, geometry.runtime]) assert.ok(control.x >= 0 && control.y >= 0 && control.right <= width + 1 && control.bottom <= height + 1, name + ' clipped control');
      assert.ok(geometry.preview.height >= 100 && geometry.scroller.height >= 140, name + ' compressed workspace');
      assert.ok(geometry.queue.bottom <= geometry.canvas.bottom + 1, name + ' clipped image queue');
      assert.equal(geometry.firstTab, 'batch-tool-upscale');
      await page.getByTestId('tool-upscale-scale-input').scrollIntoViewIfNeeded();
      const scale = await page.getByTestId('tool-upscale-scale-input').boundingBox();
      assert.ok(scale.y >= geometry.scroller.y - 1 && scale.y + scale.height <= geometry.scroller.bottom + 1, name + ' inaccessible scale control');
      await page.locator('.tool-inspector-scroll').evaluate(element => { element.scrollTop = 0; });
      await page.screenshot({ path: join(review, name + '.png') });
      console.log('PASS ' + name);
    }
  }
  }
  assert.deepEqual(errors, []);
} catch (error) { await page.screenshot({ path: join(review, 'failure.png') }).catch(() => {}); throw error; }
finally { await writeFile(join(review, 'layout.json'), JSON.stringify({ checkedAt: new Date().toISOString(), checks, errors, exe }, null, 2)); await app.close(); console.log(JSON.stringify({ checks: checks.length, errors })); }
