import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(project, 'package.json'));
const { _electron } = require(process.env.CLARUNE_PLAYWRIGHT_MODULE || 'playwright');
const sharp = require(process.env.CLARUNE_SHARP_MODULE || 'sharp');
const work = await mkdtemp(join(tmpdir(), 'clarune-enhance-layout-v5-'));
const review = process.env.CLARUNE_REVIEW_DIR || join(project, 'UI-review-v5/enhance-layout');
await mkdir(review, { recursive: true });
const fixture = join(work, '澄像 · long source image name 🧊 0123456789.png');
const comparison = join(work, 'layout-only-manual-comparison.png');
await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><defs><linearGradient id="g"><stop stop-color="#267fc9"/><stop offset="1" stop-color="#87deee"/></linearGradient></defs><rect width="320" height="200" fill="url(#g)"/><circle cx="240" cy="60" r="35" fill="#eaf9ff"/><rect x="25" y="130" width="260" height="45" rx="12" fill="#143254"/><text x="42" y="159" fill="white" font-size="21">CLARUNE LAYOUT QA</text></svg>')).png().toFile(fixture);
await sharp(fixture).resize(640, 400).png().toFile(comparison);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const exe = process.env.CLARUNE_PREVIEW_EXE || require('electron');
const app = await _electron.launch({ executablePath: exe, args: [...(process.env.CLARUNE_PREVIEW_EXE ? [] : [project]), `--user-data-dir=${join(work, 'profile')}`], env });
const page = await app.firstWindow(); page.setDefaultTimeout(20000);
await page.emulateMedia({ reducedMotion: 'reduce' });
await app.evaluate(({ BrowserWindow, ipcMain }) => {
  BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
  globalThis.layoutInferenceCalls = 0;
  ipcMain.removeHandler('image:enhance');
  ipcMain.handle('image:enhance', () => { globalThis.layoutInferenceCalls++; return { ok: false, error: 'LAYOUT_QA_INFERENCE_FORBIDDEN' }; });
});
const checks = [], errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.getByTestId('nav-settings').waitFor();
  for (const lang of ['zh-CN', 'en-US']) for (const theme of ['light', 'dark']) for (const density of ['comfortable', 'compact']) {
    await page.evaluate(values => {
      localStorage.setItem('clarune.language', values.lang);
      localStorage.setItem('clarune.theme', values.theme);
      localStorage.setItem('clarune.density', values.density);
    }, { lang, theme, density });
    await page.reload();
    await page.getByTestId('original-file-input').setInputFiles(fixture);
    await page.waitForFunction(() => !document.querySelector('[data-testid="result-file-input"]').disabled);
    for (const state of ['original', 'comparison']) {
      if (state === 'comparison') {
        await page.getByTestId('result-file-input').setInputFiles(comparison);
        await page.getByTestId('comparison-image').waitFor();
        await page.waitForFunction(() => !document.querySelector('[data-testid="result-file-input"]').disabled);
      }
      for (const [width, height] of [[980, 680], [1280, 820], [1600, 1000]]) {
        await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
        await page.waitForFunction(size => Math.abs(innerWidth - size[0]) <= 2 && Math.abs(innerHeight - size[1]) <= 2, [width, height]);
        await page.evaluate(() => { document.querySelector('.main-stage').scrollTop = 0; document.querySelector('.page-enhance .inspector').scrollTop = 0; });
        await page.waitForTimeout(80);
        const label = `${lang}-${theme}-${density}-${width}-${state}`;
        const geometry = await page.evaluate(() => {
          const main = document.querySelector('.main-stage');
          const inspector = document.querySelector('.page-enhance .inspector');
          const toolbar = document.querySelector('.page-enhance .viewer-toolbar').getBoundingClientRect();
          const buttons = [...document.querySelectorAll('.page-enhance .viewer-toolbar button')].map(button => {
            const range = document.createRange(); range.selectNodeContents(button);
            const text = range.getBoundingClientRect(), box = button.getBoundingClientRect();
            return { label: button.textContent, left: box.left, right: box.right, top: box.top, bottom: box.bottom,
              textLeft: text.left, textRight: text.right, textTop: text.top, textBottom: text.bottom };
          });
          return { inner: [innerWidth, innerHeight], body: [document.body.scrollWidth, document.body.scrollHeight],
            main: [main.clientWidth, main.scrollWidth], inspector: [inspector.clientWidth, inspector.scrollWidth],
            toolbar: { left: toolbar.left, right: toolbar.right, top: toolbar.top, bottom: toolbar.bottom }, buttons };
        });
        assert.ok(geometry.body[0] <= geometry.inner[0] + 1 && geometry.body[1] <= geometry.inner[1] + 2, label + ' body overflow');
        assert.ok(geometry.main[1] <= geometry.main[0] + 1, label + ' main horizontal overflow');
        assert.ok(geometry.inspector[1] <= geometry.inspector[0] + 1, label + ' inspector horizontal overflow');
        for (const button of geometry.buttons) {
          assert.ok(button.left >= geometry.toolbar.left - 1 && button.right <= geometry.toolbar.right + 1 && button.top >= geometry.toolbar.top - 1 && button.bottom <= geometry.toolbar.bottom + 1, label + ' toolbar button overflow: ' + button.label);
          assert.ok(button.textLeft >= button.left - 1 && button.textRight <= button.right + 1 && button.textTop >= button.top - 1 && button.textBottom <= button.bottom + 1, label + ' toolbar text overflow: ' + button.label);
        }
        if (state === 'comparison') {
          const numberHeight = await page.getByTestId('viewer-split-number').evaluate(input => input.getBoundingClientRect().height);
          assert.ok(numberHeight >= 26, label + ' comparison numeric input must retain its normal height');
          await page.getByTestId('viewer-split-number').fill('35');
          await page.getByTestId('viewer-split-number').press('Enter');
          assert.equal(await page.locator('.comparison-handle').getAttribute('aria-valuenow'), '35', label + ' typed percentage must move the divider');
          await page.getByTestId('viewer-split-number').fill('50');
          await page.getByTestId('viewer-split-number').press('Enter');
        }
        for (const id of ['enhance-start', 'compression-export', 'open-batch-upscale']) {
          await page.getByTestId(id).scrollIntoViewIfNeeded();
          const reachable = await page.getByTestId(id).evaluate(button => {
            const box = button.getBoundingClientRect();
            const pane = button.closest('.inspector').getBoundingClientRect();
            return box.left >= pane.left && box.right <= pane.right && box.top >= Math.max(0, pane.top) - 1 && box.bottom <= Math.min(innerHeight, pane.bottom) + 1;
          });
          assert.ok(reachable, label + ' inaccessible control: ' + id);
        }
        await page.getByTestId('enhance-start').scrollIntoViewIfNeeded();
        checks.push({ label, ...geometry });
        if (width === 980 && state === 'comparison' || lang === 'zh-CN' && theme === 'light' && density === 'comfortable' && width === 1600 && state === 'comparison') {
          await page.screenshot({ path: join(review, label + '.png') });
        }
      }
    }
  }
  const inferenceCalls = await app.evaluate(() => globalThis.layoutInferenceCalls);
  assert.equal(inferenceCalls, 0, 'Layout tests must never start inference');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({ passed: checks.length, inferenceCalls, errors, work, exe }));
} catch (error) {
  await page.screenshot({ path: join(review, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await writeFile(join(review, 'enhance-layout-regression.json'), JSON.stringify({ date: new Date().toISOString(), exe, checks, errors }, null, 2));
  await app.close();
}
